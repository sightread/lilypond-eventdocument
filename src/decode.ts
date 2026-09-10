/**
 * Read the JSON event-document.ily writes into an EventDocument. Validate each field.
 */
import {
  EVENT_DOCUMENT_VERSION,
  HEADER_FIELDS,
  type Attachment,
  type Context,
  type Direction,
  type Duration,
  type Event,
  type EventDocument,
  type Header,
  type LyricEvent,
  type Moment,
  type Pitch,
  type Rational,
  type ScoreEventBody,
  type SpanDirection,
  type TimeSignature,
  type VoiceEventBody,
} from './document.js'

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'DecodeError'
  }
}

type Json = { readonly [key: string]: unknown }

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Field access over one JSON object, each read with helpful errors if it fails. */
class Fields {
  constructor(
    private readonly json: Json,
    readonly path: string,
  ) {}

  private at(key: string): string {
    return `${this.path}.${key}`
  }

  has(key: string): boolean {
    const value = this.json[key]
    return (
      value !== undefined &&
      value !== null &&
      value !== false &&
      !(Array.isArray(value) && value.length === 0)
    )
  }

  raw(key: string): unknown {
    return this.json[key]
  }

  number(key: string): number {
    const value = this.json[key]
    if (typeof value !== 'number') throw new DecodeError(this.at(key), 'expected a number')
    return value
  }

  integer(key: string): number {
    const value = this.number(key)
    if (!Number.isInteger(value)) throw new DecodeError(this.at(key), 'expected an integer')
    return value
  }

  string(key: string): string {
    const value = this.json[key]
    if (typeof value !== 'string') throw new DecodeError(this.at(key), 'expected a string')
    return value
  }

  optionalString(key: string): string | undefined {
    return this.has(key) ? this.string(key) : undefined
  }

  boolean(key: string, fallback?: boolean): boolean {
    const value = this.json[key]
    if (typeof value === 'boolean') return value
    if (!this.has(key) && fallback !== undefined) return fallback
    throw new DecodeError(this.at(key), 'expected a boolean')
  }

  rational(key: string): Rational {
    return rational(this.json[key], this.at(key))
  }

  pitch(key: string): Pitch {
    return pitch(this.json[key], this.at(key))
  }

  duration(key: string): Duration | null {
    return this.has(key) ? duration(this.json[key], this.at(key)) : null
  }

  optionalDuration(key: string): Duration | undefined {
    return this.has(key) ? duration(this.json[key], this.at(key)) : undefined
  }

  /** A LilyPond direction: -1 or 1; 0 (CENTER) and unset both mean no side was chosen. */
  optionalDirection(key: string): Direction | undefined {
    if (!this.has(key)) return undefined
    const value = this.integer(key)
    return value === -1 || value === 1 ? value : undefined
  }

  spanDirection(): SpanDirection {
    const value = this.integer('span-direction')
    if (value !== -1 && value !== 1)
      throw new DecodeError(this.at('span-direction'), 'expected -1 or 1')
    return value
  }

  integers(key: string): number[] {
    const value = this.json[key]
    if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item)))
      throw new DecodeError(this.at(key), 'expected a list of integers')
    return value as number[]
  }

  optionalIntegers(key: string): number[] | undefined {
    return this.has(key) ? this.integers(key) : undefined
  }

  list(key: string): Fields[] {
    const value = this.json[key]
    if (!Array.isArray(value)) throw new DecodeError(this.at(key), 'expected a list')
    return value.map((item, index) => {
      if (!isObject(item)) throw new DecodeError(`${this.at(key)}[${index}]`, 'expected an object')
      return new Fields(item, `${this.at(key)}[${index}]`)
    })
  }

  object(key: string): Fields {
    const value = this.json[key]
    if (!isObject(value)) throw new DecodeError(this.at(key), 'expected an object')
    return new Fields(value, this.at(key))
  }
}

function rational(value: unknown, path: string): Rational {
  if (typeof value === 'number' && Number.isInteger(value))
    return { numerator: value, denominator: 1 }
  if (typeof value === 'string') {
    const match = /^(-?\d+)(?:\/(\d+))?$/.exec(value)
    if (match) return { numerator: Number(match[1]), denominator: match[2] ? Number(match[2]) : 1 }
  }
  throw new DecodeError(path, 'expected an integer or an "n/d" string')
}

function pitch(value: unknown, path: string): Pitch {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1])
  )
    throw new DecodeError(path, 'expected [octave, step, alteration]')
  return {
    octave: value[0] as number,
    step: value[1] as number,
    alteration: rational(value[2], `${path}[2]`),
  }
}

function duration(value: unknown, path: string): Duration {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1])
  )
    throw new DecodeError(path, 'expected [log, dots, scale]')
  return {
    log: value[0] as number,
    dots: value[1] as number,
    scale: rational(value[2], `${path}[2]`),
  }
}

function timeSignature(fields: Fields, key: string): TimeSignature | undefined {
  if (!fields.has(key)) return undefined
  const value = fields.raw(key)
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isInteger(item)))
    throw new DecodeError(`${fields.path}.${key}`, 'expected [numerator, denominator]')
  return { numerator: value[0] as number, denominator: value[1] as number }
}

function moment(fields: Fields): Moment {
  return { main: fields.rational('m'), grace: fields.rational('g') }
}

/** The side a mark was forced to, on the event or as a `direction` tweak (the \lheel and
 *  \rheel pair carry theirs that way). */
function placement(fields: Fields): { direction?: Direction } {
  let direction = fields.optionalDirection('direction')
  if (direction === undefined && fields.has('tweaks')) {
    const tweaks = fields.raw('tweaks')
    if (!Array.isArray(tweaks)) throw new DecodeError(`${fields.path}.tweaks`, 'expected a list')
    const tweak = tweaks.find(
      (entry) =>
        Array.isArray(entry) &&
        (entry[0] === 'direction' || (Array.isArray(entry[0]) && entry[0][1] === 'direction')),
    )
    if (tweak?.[1] === -1 || tweak?.[1] === 1) direction = tweak[1]
  }
  return direction === undefined ? {} : { direction }
}

function voiceEventBody(fields: Fields, cls: string): VoiceEventBody | undefined {
  switch (cls) {
    case 'tie-event':
    case 'repeat-tie-event':
    case 'laissez-vibrer-event':
    case 'harmonic-event':
    case 'glissando-event':
    case 'note-grouping-event':
      return { class: cls }
    case 'articulation-event':
    case 'multi-measure-articulation-event':
      return {
        class: cls,
        articulationType: fields.string('articulation-type'),
        ...placement(fields),
      }
    case 'fingering-event':
      return {
        class: cls,
        ...(fields.has('digit') ? { digit: fields.integer('digit') } : {}),
        ...(fields.has('text') ? { text: fields.string('text') } : {}),
        ...placement(fields),
      }
    case 'text-script-event':
    case 'multi-measure-text-event':
    case 'absolute-dynamic-event':
      return { class: cls, text: fields.string('text'), ...placement(fields) }
    case 'crescendo-event':
    case 'decrescendo-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('span-type') ? { spanType: fields.string('span-type') } : {}),
        ...(fields.has('span-text') ? { spanText: fields.string('span-text') } : {}),
        ...(fields.has('circled-tip') ? { circledTip: fields.boolean('circled-tip') } : {}),
        ...(fields.has('spanner-style') ? { spannerStyle: fields.string('spanner-style') } : {}),
        ...(fields.has('spanner-text') ? { spannerText: fields.string('spanner-text') } : {}),
        ...placement(fields),
      }
    case 'sustain-event':
    case 'sostenuto-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('pedal-style') ? { pedalStyle: fields.string('pedal-style') } : {}),
      }
    case 'una-corda-event':
    case 'measure-spanner-event':
      return { class: cls, spanDirection: fields.spanDirection() }
    case 'tuplet-span-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('numerator') ? { numerator: fields.integer('numerator') } : {}),
        ...(fields.has('denominator') ? { denominator: fields.integer('denominator') } : {}),
      }
    case 'trill-span-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('pitch') ? { pitch: fields.pitch('pitch') } : {}),
      }
    case 'text-span-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        text: fields.has('text') ? fields.string('text') : '',
        ...placement(fields),
      }
    case 'slur-event':
    case 'phrasing-slur-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('grob-direction')
          ? { grobDirection: fields.optionalDirection('grob-direction') }
          : {}),
        ...placement(fields),
      }
    case 'beam-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('grow-direction')
          ? { growDirection: fields.optionalDirection('grow-direction') }
          : {}),
      }
    case 'breathing-event':
    case 'caesura-event':
      return { class: cls, attachments: attachments(fields) }
    case 'tremolo-event':
      return { class: cls, tremoloType: fields.integer('tremolo-type') }
    case 'tremolo-span-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        ...(fields.has('tremolo-type') ? { tremoloType: fields.integer('tremolo-type') } : {}),
        ...(fields.has('repeat-count') ? { repeatCount: fields.integer('repeat-count') } : {}),
      }
    case 'arpeggio-event': {
      const style = fields.optionalString('arpeggio-style') ?? 'normal'
      if (style !== 'normal' && style !== 'bracket' && style !== 'parenthesis')
        throw new DecodeError(`${fields.path}.arpeggio-style`, `unknown style ${style}`)
      return {
        class: cls,
        ...(fields.has('arpeggio-direction')
          ? { arpeggioDirection: fields.optionalDirection('arpeggio-direction') }
          : {}),
        arpeggioStyle: style,
      }
    }
    case 'string-number-event':
      return { class: cls, stringNumber: fields.integer('string-number'), ...placement(fields) }
    case 'stroke-finger-event':
      return {
        class: cls,
        ...(fields.has('stroke-finger-digit')
          ? { strokeFingerDigit: fields.integer('stroke-finger-digit') }
          : {}),
        ...(fields.has('stroke-finger-text')
          ? { strokeFingerText: fields.string('stroke-finger-text') }
          : {}),
        ...placement(fields),
      }
    case 'bend-after-event':
      return { class: cls, deltaStep: fields.number('delta-step') }
  }
  return undefined
}

/** A note's post-events. Those reach the listener as stream events (`c`) or, for exotic
 *  constructs, as music objects (`name`). */
function attachments(fields: Fields): Attachment[] {
  if (!fields.has('a')) return []
  return fields.list('a').map((entry) => {
    if (entry.has('c')) {
      const cls = entry.string('c')
      return voiceEventBody(entry, cls) ?? { class: 'ignored', name: cls }
    }
    return { class: 'ignored', name: entry.optionalString('name') ?? '' }
  })
}

function scoreEventBody(fields: Fields, cls: string): ScoreEventBody {
  switch (cls) {
    case 'tempo-change-event': {
      const count = fields.raw('metronome-count')
      let metronomeCount: number | readonly [number, number] | undefined
      if (typeof count === 'number') metronomeCount = count
      else if (Array.isArray(count) && count.length === 2 && count.every(Number.isFinite))
        metronomeCount = [count[0], count[1]]
      else if (fields.has('metronome-count'))
        throw new DecodeError(`${fields.path}.metronome-count`, 'expected a number or a pair')
      return {
        class: cls,
        ...(metronomeCount !== undefined ? { metronomeCount } : {}),
        ...(fields.has('tempo-unit') ? { tempoUnit: fields.optionalDuration('tempo-unit') } : {}),
        ...(fields.has('text') ? { text: fields.string('text') } : {}),
      }
    }
    case 'time-signature-event':
    case 'reference-time-signature-event':
    case 'polymetric-time-signature-event':
      return {
        class: cls,
        ...(fields.has('numerator') ? { numerator: fields.integer('numerator') } : {}),
        ...(fields.has('denominator') ? { denominator: fields.integer('denominator') } : {}),
      }
    case 'bar-event':
      return { class: cls, barType: fields.optionalString('bar-type') ?? '' }
    case 'volta-repeat-start-event':
      return {
        class: cls,
        ...(fields.has('repeat-count') ? { repeatCount: fields.integer('repeat-count') } : {}),
      }
    case 'volta-repeat-end-event':
    case 'dal-segno-event':
      return {
        class: cls,
        ...(fields.has('repeat-count') ? { repeatCount: fields.integer('repeat-count') } : {}),
        ...(fields.has('alternative-number')
          ? { alternativeNumber: fields.integer('alternative-number') }
          : {}),
      }
    case 'alternative-event':
      return {
        class: cls,
        ...(fields.has('alternative-dir')
          ? { alternativeDir: fields.integer('alternative-dir') }
          : {}),
        ...(fields.has('volta-numbers') ? { voltaNumbers: fields.integers('volta-numbers') } : {}),
      }
    case 'volta-span-event':
      return {
        class: cls,
        spanDirection: fields.spanDirection(),
        voltaNumbers: fields.optionalIntegers('volta-numbers') ?? [],
        ...(fields.has('repeat-count') ? { repeatCount: fields.integer('repeat-count') } : {}),
      }
    case 'fine-event':
    case 'section-event':
      return { class: cls }
    case 'segno-mark-event':
    case 'coda-mark-event':
    case 'rehearsal-mark-event':
      return { class: cls, ...(fields.has('label') ? { label: fields.integer('label') } : {}) }
    case 'ad-hoc-mark-event':
    case 'text-mark-event':
    case 'ad-hoc-jump-event':
    case 'section-label-event':
      return { class: cls, text: fields.optionalString('text') ?? '' }
  }
  throw new DecodeError(`${fields.path}.c`, `unknown score event class ${cls}`)
}

function event(fields: Fields): Event {
  const kind = fields.string('k')
  switch (kind) {
    case 'note': {
      const stem = fields.optionalString('stem')
      if (stem !== undefined && stem !== 'up' && stem !== 'down')
        throw new DecodeError(`${fields.path}.stem`, `expected up or down`)
      return {
        kind,
        moment: moment(fields),
        voice: fields.integer('v'),
        staff: fields.integer('s'),
        duration: fields.duration('d'),
        ...(fields.has('pitch') ? { pitch: fields.pitch('pitch') } : {}),
        ...(fields.has('drum-type') ? { drumType: fields.string('drum-type') } : {}),
        ...(fields.has('force-accidental')
          ? { forceAccidental: fields.boolean('force-accidental') }
          : {}),
        ...(fields.has('cautionary') ? { cautionary: fields.boolean('cautionary') } : {}),
        attachments: attachments(fields),
        slash: fields.boolean('slash', false),
        hidden: fields.boolean('hidden', false),
        parenthesized: fields.boolean('parenthesized', false),
        ...(fields.has('style') ? { noteheadStyle: fields.string('style') } : {}),
        ...(stem ? { stem } : {}),
        mergeDifferentlyHeaded: fields.boolean('merge', false),
      }
    }
    case 'rest':
    case 'mmrest':
    case 'skip':
      return {
        kind,
        moment: moment(fields),
        voice: fields.integer('v'),
        staff: fields.integer('s'),
        duration: fields.duration('d'),
        ...(fields.has('pitch') ? { pitch: fields.pitch('pitch') } : {}),
      }
    case 'ev': {
      const cls = fields.string('c')
      const body = voiceEventBody(fields, cls)
      if (!body) throw new DecodeError(`${fields.path}.c`, `unknown voice event class ${cls}`)
      return {
        kind: 'voice',
        moment: moment(fields),
        voice: fields.integer('v'),
        staff: fields.integer('s'),
        ...body,
      }
    }
    case 'score':
      return { kind, moment: moment(fields), ...scoreEventBody(fields, fields.string('c')) }
    case 'staff': {
      const cls = fields.string('c')
      if (cls !== 'key-change-event')
        throw new DecodeError(`${fields.path}.c`, `unknown staff event class ${cls}`)
      const alist = fields.raw('pitch-alist')
      if (!Array.isArray(alist))
        throw new DecodeError(`${fields.path}.pitch-alist`, 'expected a list of pairs')
      return {
        kind,
        class: cls,
        moment: moment(fields),
        staff: fields.integer('s'),
        tonic: fields.pitch('tonic'),
        pitchAlist: alist.map((entry, index) => {
          const at = `${fields.path}.pitch-alist[${index}]`
          if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]))
            throw new DecodeError(at, 'expected [step, alteration]')
          return [entry[0] as number, rational(entry[1], `${at}[1]`)] as const
        }),
      }
    }
    case 'step':
      return {
        kind,
        moment: moment(fields),
        bar: fields.integer('bar'),
        position: fields.rational('pos'),
        length: fields.rational('len'),
        ...(fields.has('time') ? { time: timeSignature(fields, 'time') } : {}),
        timing: fields.boolean('timing', true),
      }
    case 'clef':
      return {
        kind,
        moment: moment(fields),
        staff: fields.integer('s'),
        ...(fields.has('glyph') ? { glyph: fields.string('glyph') } : {}),
        position: fields.has('pos') ? fields.number('pos') : 0,
        transposition: fields.has('transp') ? fields.number('transp') : 0,
      }
    case 'ottava':
      return {
        kind,
        moment: moment(fields),
        staff: fields.integer('s'),
        offset: fields.has('offset') ? fields.number('offset') : 0,
      }
    case 'timestyle':
      return {
        kind: 'timeSignatureStyle',
        moment: moment(fields),
        staff: fields.integer('s'),
        ...(fields.has('style') ? { style: fields.string('style') } : {}),
      }
    case 'tempo':
      return { kind, moment: moment(fields), wholesPerMinute: fields.rational('wholes-per-minute') }
    case 'staffmeta':
      return {
        kind: 'staffMeta',
        moment: moment(fields),
        staff: fields.integer('s'),
        instrumentName: fields.optionalString('instrument') ?? '',
        shortInstrumentName: fields.optionalString('short') ?? '',
      }
    case 'lyric': {
      const cls = fields.string('c')
      if (cls !== 'lyric-event' && cls !== 'hyphen-event' && cls !== 'extender-event')
        throw new DecodeError(`${fields.path}.c`, `unknown lyric event class ${cls}`)
      const lyric: LyricEvent = {
        kind,
        class: cls,
        moment: moment(fields),
        verse: fields.integer('verse'),
        voice: fields.has('voice') ? fields.integer('voice') : null,
        ...(fields.has('text') ? { text: fields.string('text') } : {}),
        duration: fields.duration('d'),
      }
      return lyric
    }
  }
  throw new DecodeError(`${fields.path}.k`, `unknown event kind ${kind}`)
}

function context(fields: Fields): Context {
  return {
    id: fields.integer('id'),
    type: fields.string('type'),
    name: fields.optionalString('name') ?? '',
    parent: fields.has('parent') ? fields.integer('parent') : null,
  }
}

function header(fields: Fields): Header {
  const result: { -readonly [K in keyof Header]: Header[K] } = {}
  for (const field of HEADER_FIELDS) {
    if (fields.has(field)) result[field] = fields.string(field)
  }
  return result
}

export function decodeEventDocument(json: string): EventDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new DecodeError('$', error instanceof Error ? error.message : String(error))
  }
  if (!isObject(parsed)) throw new DecodeError('$', 'expected an object')
  const root = new Fields(parsed, '$')
  const version = root.integer('version')
  if (version !== EVENT_DOCUMENT_VERSION)
    throw new DecodeError('$.version', `unsupported event document version ${version}`)
  return {
    version,
    source: root.string('source'),
    lilypondVersion: root.string('lilypond'),
    header: header(root.object('header')),
    contexts: root.list('contexts').map(context),
    events: root.list('events').map(event),
  }
}
