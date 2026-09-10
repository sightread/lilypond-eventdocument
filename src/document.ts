/**
 * A LilyPond score after parsing and expansion.
 */

/** Bumped when event-document.ily changes what it writes. */
export const EVENT_DOCUMENT_VERSION = 1

export interface Rational {
  readonly numerator: number
  readonly denominator: number
}

export type ContextId = number

/** `type` is the context type name: Score, Staff, PianoStaff, Voice, Lyrics, or a user-defined one. */
export interface Context {
  readonly id: ContextId
  readonly type: string
  readonly name: string
  readonly parent: ContextId | null
}

export const HEADER_FIELDS = [
  'title',
  'subtitle',
  'subsubtitle',
  'composer',
  'arranger',
  'poet',
  'opus',
  'piece',
  'copyright',
  'source',
  'style',
  'maintainer',
  'license',
  'mutopiatitle',
  'mutopiacomposer',
  'mutopiaopus',
  'mutopiainstrument',
  'date',
] as const

export type HeaderField = (typeof HEADER_FIELDS)[number]

export type Header = Readonly<Partial<Record<HeaderField, string>>>

/** LilyPond's moment: grace time is negative and runs up to the main moment. */
export interface Moment {
  readonly main: Rational
  readonly grace: Rational
}

/** A quarter is log 2; `c8*2/3` has scale 2/3. */
export interface Duration {
  readonly log: number
  readonly dots: number
  readonly scale: Rational
}

/** Octave 0 is the c' octave, step 0–6 is C–B, alteration is in whole tones (a sharp is 1/2). */
export interface Pitch {
  readonly octave: number
  readonly step: number
  readonly alteration: Rational
}

export interface TimeSignature {
  readonly numerator: number
  readonly denominator: number
}

/** `^` or `_` on a mark, or an \override that forces a side. */
export type Direction = -1 | 1

/** -1 opens a span, 1 closes it. */
export type SpanDirection = -1 | 1

interface VoiceLocation {
  readonly moment: Moment
  readonly voice: ContextId
  readonly staff: ContextId
}

export interface NoteEvent extends VoiceLocation {
  readonly kind: 'note'
  /** null for the placeholders LilyPond's part combiner emits. */
  readonly duration: Duration | null
  readonly pitch?: Pitch
  readonly drumType?: string
  readonly forceAccidental?: boolean
  readonly cautionary?: boolean
  /** The note's own post-events (`c4-.~`), as opposed to the chord's. */
  readonly attachments: readonly Attachment[]
  readonly slash: boolean
  readonly hidden: boolean
  readonly parenthesized: boolean
  /** NoteHead.style in force: cross, diamond, harmonic, slash, a shape-note name... */
  readonly noteheadStyle?: string
  readonly stem?: 'up' | 'down'
  readonly mergeDifferentlyHeaded: boolean
}

export interface RestEvent extends VoiceLocation {
  readonly kind: 'rest' | 'mmrest' | 'skip'
  readonly duration: Duration | null
  /** A pitched rest (`c4\rest`). */
  readonly pitch?: Pitch
}

interface Span {
  readonly spanDirection: SpanDirection
}

interface Placed {
  readonly direction?: Direction
}

export type VoiceEventBody =
  | { readonly class: 'tie-event' }
  | { readonly class: 'repeat-tie-event' }
  | { readonly class: 'laissez-vibrer-event' }
  | { readonly class: 'harmonic-event' }
  | { readonly class: 'glissando-event' }
  | { readonly class: 'note-grouping-event' }
  | ({
      readonly class: 'articulation-event' | 'multi-measure-articulation-event'
      /** The script name: staccato, fermata, trill, upbow... */
      readonly articulationType: string
    } & Placed)
  | ({
      readonly class: 'fingering-event'
      readonly digit?: number
      readonly text?: string
    } & Placed)
  | ({
      readonly class: 'text-script-event' | 'multi-measure-text-event'
      readonly text: string
    } & Placed)
  | ({ readonly class: 'absolute-dynamic-event'; readonly text: string } & Placed)
  | ({
      readonly class: 'crescendo-event' | 'decrescendo-event'
      readonly spanType?: string
      readonly spanText?: string
      readonly circledTip?: boolean
      /** crescendoSpanner or decrescendoSpanner in force; \crescTextCresc makes it 'text'. */
      readonly spannerStyle?: string
      readonly spannerText?: string
    } & Span &
      Placed)
  | ({ readonly class: 'sustain-event' | 'sostenuto-event'; readonly pedalStyle?: string } & Span)
  | ({ readonly class: 'una-corda-event' } & Span)
  | ({
      readonly class: 'tuplet-span-event'
      readonly numerator?: number
      readonly denominator?: number
    } & Span)
  | ({ readonly class: 'trill-span-event'; readonly pitch?: Pitch } & Span)
  | ({ readonly class: 'text-span-event'; readonly text: string } & Span & Placed)
  | ({
      readonly class: 'slur-event' | 'phrasing-slur-event'
      /** \slurUp and friends: the grob's direction override. */
      readonly grobDirection?: Direction
    } & Span &
      Placed)
  | ({ readonly class: 'beam-event'; readonly growDirection?: Direction } & Span)
  | ({ readonly class: 'measure-spanner-event' } & Span)
  | {
      readonly class: 'breathing-event' | 'caesura-event'
      readonly attachments: readonly Attachment[]
    }
  | { readonly class: 'tremolo-event'; readonly tremoloType: number }
  | ({
      readonly class: 'tremolo-span-event'
      /** On the start only. */
      readonly tremoloType?: number
      readonly repeatCount?: number
    } & Span)
  | {
      readonly class: 'arpeggio-event'
      readonly arpeggioDirection?: Direction
      readonly arpeggioStyle: 'normal' | 'bracket' | 'parenthesis'
    }
  | ({ readonly class: 'string-number-event'; readonly stringNumber: number } & Placed)
  | ({
      readonly class: 'stroke-finger-event'
      readonly strokeFingerDigit?: number
      readonly strokeFingerText?: string
    } & Placed)
  | { readonly class: 'bend-after-event'; readonly deltaStep: number }

export type VoiceEvent = { readonly kind: 'voice' } & VoiceLocation & VoiceEventBody

/** A post-event stored on the note itself. A class the voice engraver does not listen for is
 *  kept by name, so an exotic `c4-\something` never fails a decode. */
export type Attachment = VoiceEventBody | { readonly class: 'ignored'; readonly name: string }

export type ScoreEventBody =
  | {
      readonly class: 'tempo-change-event'
      readonly metronomeCount?: number | readonly [number, number]
      readonly tempoUnit?: Duration
      readonly text?: string
    }
  | {
      /** The listener registers time-signature-event; LilyPond logs its subclasses by name. */
      readonly class:
        | 'time-signature-event'
        | 'reference-time-signature-event'
        | 'polymetric-time-signature-event'
      readonly numerator?: number
      readonly denominator?: number
    }
  | { readonly class: 'bar-event'; readonly barType: string }
  | { readonly class: 'volta-repeat-start-event'; readonly repeatCount?: number }
  | {
      readonly class: 'volta-repeat-end-event'
      readonly repeatCount?: number
      readonly alternativeNumber?: number
    }
  | {
      readonly class: 'alternative-event'
      readonly alternativeDir?: number
      readonly voltaNumbers?: readonly number[]
    }
  | ({
      readonly class: 'volta-span-event'
      readonly voltaNumbers: readonly number[]
      readonly repeatCount?: number
    } & Span)
  | { readonly class: 'fine-event' }
  | {
      readonly class: 'dal-segno-event'
      readonly repeatCount?: number
      readonly alternativeNumber?: number
    }
  | {
      readonly class: 'segno-mark-event' | 'coda-mark-event' | 'rehearsal-mark-event'
      readonly label?: number
    }
  | {
      readonly class:
        'ad-hoc-mark-event' | 'text-mark-event' | 'ad-hoc-jump-event' | 'section-label-event'
      readonly text: string
    }
  | { readonly class: 'section-event' }

export type ScoreEvent = { readonly kind: 'score'; readonly moment: Moment } & ScoreEventBody

export interface KeyChangeEvent {
  readonly kind: 'staff'
  readonly class: 'key-change-event'
  readonly moment: Moment
  readonly staff: ContextId
  readonly tonic: Pitch
  /** Each scale step's alteration, `[step, alteration]`. */
  readonly pitchAlist: readonly (readonly [number, Rational])[]
}

/** The Timing translator's bookkeeping, logged whenever the bar number, its length, the meter
 *  or \cadenzaOn changes. */
export interface StepEvent {
  readonly kind: 'step'
  readonly moment: Moment
  readonly bar: number
  readonly position: Rational
  readonly length: Rational
  readonly time?: TimeSignature
  readonly timing: boolean
}

export interface ClefEvent {
  readonly kind: 'clef'
  readonly moment: Moment
  readonly staff: ContextId
  /** clefs.G, clefs.F, clefs.C, clefs.percussion, clefs.tab; absent before any \clef. */
  readonly glyph?: string
  readonly position: number
  readonly transposition: number
}

export interface OttavaEvent {
  readonly kind: 'ottava'
  readonly moment: Moment
  readonly staff: ContextId
  /** middleCOffset in staff steps; \ottava #1 is -7. */
  readonly offset: number
}

export interface TimeSignatureStyleEvent {
  readonly kind: 'timeSignatureStyle'
  readonly moment: Moment
  readonly staff: ContextId
  readonly style?: string
}

/** Score.tempoWholesPerMinute changed; a \tempo mark sets it too. */
export interface TempoEvent {
  readonly kind: 'tempo'
  readonly moment: Moment
  readonly wholesPerMinute: Rational
}

export interface StaffMetaEvent {
  readonly kind: 'staffMeta'
  readonly moment: Moment
  readonly staff: ContextId
  readonly instrumentName: string
  readonly shortInstrumentName: string
}

export interface LyricEvent {
  readonly kind: 'lyric'
  readonly class: 'lyric-event' | 'hyphen-event' | 'extender-event'
  readonly moment: Moment
  readonly verse: ContextId
  readonly voice: ContextId | null
  readonly text?: string
  readonly duration: Duration | null
}

export type Event =
  | NoteEvent
  | RestEvent
  | VoiceEvent
  | ScoreEvent
  | KeyChangeEvent
  | StepEvent
  | ClefEvent
  | OttavaEvent
  | TimeSignatureStyleEvent
  | TempoEvent
  | StaffMetaEvent
  | LyricEvent

export interface EventDocument {
  readonly version: typeof EVENT_DOCUMENT_VERSION
  readonly source: string
  readonly lilypondVersion: string
  readonly header: Header
  readonly contexts: readonly Context[]
  readonly events: readonly Event[]
}
