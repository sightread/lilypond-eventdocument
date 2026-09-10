\version "2.26.0"

%% Copyright (C) 2026 Jake Fried. GPL-3.0-or-later; see the LICENSE beside this file.
%%
%% event-document.ily — write a LilyPond score's translated events as a JSON event document.
%%
%%   lilypond -dinclude-settings=event-document.ily -o out/<stem> <file>.ly
%%
%% writes `out/<stem>.events.json`.
%%
%% LilyPond parses and expands the source before this listener receives events, so macros,
%% \relative, \transpose, \include, \parallelMusic and Scheme functions in the source have been
%% resolved and every event has a measure position.

#(use-modules (ice-9 ftw) (srfi srfi-1))

%%% ---------------------------------------------------------------- JSON

#(define (ed-json-escape s)
   (call-with-output-string
    (lambda (port)
      (string-for-each
       (lambda (ch)
         (cond ((char=? ch #\") (display "\\\"" port))
               ((char=? ch #\\) (display "\\\\" port))
               ((char=? ch #\newline) (display "\\n" port))
               ((char=? ch #\tab) (display "\\t" port))
               ((char=? ch #\return) (display "\\r" port))
               ((< (char->integer ch) 32) (format port "\\u~4,'0x" (char->integer ch)))
               (else (write-char ch port))))
       s))))

%% Vectors become JSON arrays, alists become objects, exact rationals become "n/d" strings
%% (JSON numbers would lose them), the symbol 'null becomes null.
#(define (ed-json v port)
   (cond ((eq? v #t) (display "true" port))
         ((eq? v #f) (display "false" port))
         ((eq? v 'null) (display "null" port))
         ((string? v) (display "\"" port) (display (ed-json-escape v) port) (display "\"" port))
         ((symbol? v) (ed-json (symbol->string v) port))
         ((and (number? v) (exact? v) (integer? v)) (display v port))
         ((and (number? v) (exact? v) (rational? v)) (ed-json (number->string v) port))
         ((number? v) (display (exact->inexact v) port))
         ((vector? v)
          (display "[" port)
          (let loop ((i 0))
            (when (< i (vector-length v))
              (if (> i 0) (display "," port))
              (ed-json (vector-ref v i) port)
              (loop (+ i 1))))
          (display "]" port))
         ((list? v)
          (display "{" port)
          (let loop ((l v) (first #t))
            (when (pair? l)
              (if (not first) (display "," port))
              (ed-json (symbol->string (caar l)) port)
              (display ":" port)
              (ed-json (cdar l) port)
              (loop (cdr l) #f)))
          (display "}" port))
         (else (ed-json (format #f "~a" v) port))))

%%% ---------------------------------------------------------------- value serializers

#(define (ed-pitch p)
   (vector (ly:pitch-octave p) (ly:pitch-notename p) (ly:pitch-alteration p)))

#(define (ed-duration d)
   (if (ly:duration? d)
       (vector (ly:duration-log d) (ly:duration-dot-count d) (ly:duration-scale d))
       'null))

%% Run a listener body, and report where errors occur. LilyPond reports a Scheme error in
%% an engraver as "Guile signaled an error" at init.ly, which is too lossy.
#(define (ed-guard name thunk)
   (catch #t
     thunk
     (lambda (key . args)
       (ly:progress "lilypond-event-document: error in ~a: ~a ~s\n" name key args)
       (apply throw key args))))

%% Rendering a markup to text runs its commands, and a source's own markup can be broken in
%% ways LilyPond only notices on the page (an undefined size argument, say). Text is a
%% nicety here, so swallow that and move on.
#(define (ed-markup->string v)
   (catch #t
     (lambda () (markup->string v))
     (lambda (key . args) "")))

#(define (ed-value v)
   (cond ((ly:pitch? v) (ed-pitch v))
         ((ly:duration? v) (ed-duration v))
         ((ly:moment? v) (ly:moment-main v))
         ((markup? v) (ed-markup->string v))
         ((or (string? v) (symbol? v) (number? v) (boolean? v)) v)
         ((and (pair? v) (not (list? v))) (vector (ed-value (car v)) (ed-value (cdr v))))
         ((list? v) (list->vector (map ed-value v)))
         (else 'null)))

%% The event properties we keep. Add to this as we realize we need more.
#(define ed-event-props
   '(articulation-type span-direction direction text digit numerator denominator
     metronome-count tempo-unit tonic pitch-alist volta-numbers alternative-number
     alternative-dir type bar-type repeat-count span-type span-text tremolo-type label pitch
     drum-type force-accidental cautionary parenthesize tweaks string-number delta-step
     stroke-finger-digit stroke-finger-text))

#(define (ed-event-alist ev)
   (filter-map
    (lambda (key)
      (let ((v (ly:event-property ev key '())))
        (and (not (null? v)) (cons key (ed-value v)))))
    ed-event-props))

%% A note's own post-events (`c4-.~`), as opposed to the chord's (`<c e>4-.~`), which arrive
%% as separate events in the same timestep.
%% By the time a note reaches an engraver its articulations are already stream events; a
%% music object only turns up here for exotic constructs, so accept both.
#(define (ed-articulation art)
   (if (ly:stream-event? art)
       (cons (cons 'c (car (ly:event-property art 'class))) (ed-event-alist art))
       (cons (cons 'name (ly:music-property art 'name))
             (filter-map
              (lambda (key)
                (let ((v (ly:music-property art key '())))
                  (and (not (null? v)) (cons key (ed-value v)))))
              ed-event-props))))

%%% ---------------------------------------------------------------- contexts

#(define ed-context-table (make-hash-table))
#(define ed-contexts '())
#(define ed-next-context-id 0)

#(define (ed-context-id ctx)
   (or (hashq-ref ed-context-table ctx)
       ;; Register the parent first: it takes the next id, and this context the one after.
       (let* ((parent (ly:context-parent ctx))
              (parent-id (if (and (ly:context? parent)
                                  (not (memq (ly:context-name parent) '(Global))))
                             (ed-context-id parent)
                             'null))
              (id ed-next-context-id))
         (set! ed-next-context-id (+ id 1))
         (hashq-set! ed-context-table ctx id)
         (set! ed-contexts
               (cons `((id . ,id)
                       (type . ,(ly:context-name ctx))
                       (name . ,(ly:context-id ctx))
                       (parent . ,parent-id))
                     ed-contexts))
         id)))

%%% ---------------------------------------------------------------- event log

#(define ed-events '())
#(define ed-header '())

#(define (ed-push! ctx fields)
   (let ((moment (ly:context-current-moment ctx)))
     (set! ed-events
           (cons (append `((m . ,(ly:moment-main moment))
                           (g . ,(ly:moment-grace moment)))
                         fields)
                 ed-events))))

#(define (ed-voice-fields engraver)
   (let ((ctx (ly:translator-context engraver)))
     `((v . ,(ed-context-id ctx))
       (s . ,(ed-context-id (ly:context-parent ctx))))))

%% `\once \override NoteHead.transparent = ##t`: a note that sounds but is not drawn. Mutopia
%% typesetters plant one to anchor a slur on a staff whose voice has moved away.
#(define (ed-hidden-note? ctx)
   (let ((head (ly:context-grob-definition ctx 'NoteHead)))
     (and (pair? head) (eq? (assoc-get 'transparent head) #t))))

%% \stemUp / \stemDown / \voiceOne: a forced stem direction is a Stem.direction override.
#(define (ed-stem-direction ctx)
   (let* ((stem (ly:context-grob-definition ctx 'Stem))
          (dir (and (pair? stem) (assoc-get 'direction stem))))
     (cond ((and (number? dir) (> dir 0)) 'up)
           ((and (number? dir) (< dir 0)) 'down)
           (else 'null))))

%% \mergeDifferentlyHeadedOn: NoteCollision.merge-differently-headed on the staff.
#(define (ed-merge-heads? ctx)
   (let ((collision (ly:context-grob-definition ctx 'NoteCollision)))
     (and (pair? collision) (eq? (assoc-get 'merge-differently-headed collision) #t))))

#(define (ed-grace-slash? ctx)
   (let ((flag (ly:context-grob-definition ctx 'Flag)))
     (and (pair? flag) (equal? (assoc-get 'stroke-style flag) "grace"))))

%% A grob property from the context's current definition of that grob (an \override in
%% force), or 'null when nothing set it.
#(define (ed-grob-property ctx grob prop)
   (let* ((def (ly:context-grob-definition ctx grob))
          (v (and (pair? def) (assoc-get prop def))))
     (if (or (eq? v #f) (null? v) (not v)) 'null (ed-value v))))

%% \override NoteHead.style (cross, diamond, harmonic, slash...); the same override on a
%% single note (\xNote, \parenthesize) travels as a tweak on the event, see 'tweaks.
#(define (ed-notehead-style ctx)
   (let* ((def (ly:context-grob-definition ctx 'NoteHead))
          (style (and (pair? def) (assoc-get 'style def))))
     (cond ((symbol? style) style)
           ;; \xNotesOn overrides the style with the cross-style procedure.
           ((and (procedure? style) (defined? 'cross-style) (eq? style cross-style)) 'cross)
           (else 'null))))

%% A \tweak on the note itself: `(style . cross)`, or `((NoteHead . style) . cross)`.
#(define (ed-tweak event key)
   (let ((entry (find (lambda (tweak)
                        (or (eq? (car tweak) key)
                            (and (pair? (car tweak)) (eq? (cdr (car tweak)) key))))
                      (ly:event-property event 'tweaks '()))))
     (and entry (cdr entry))))

%% The head style in force for a note: its own tweak (\xNote tweaks the cross-style
%% procedure, which picks the cross head by duration) over the context's override.
#(define (ed-note-style ctx event)
   (let ((tweak (ed-tweak event 'style)))
     (cond ((symbol? tweak) tweak)
           ((and (procedure? tweak) (defined? 'cross-style) (eq? tweak cross-style)) 'cross)
           (else (ed-notehead-style ctx)))))

%% \arpeggioArrowUp / \arpeggioArrowDown set Arpeggio.arpeggio-direction; \arpeggioBracket
%% and \arpeggioParenthesis swap the stencil.
#(define (ed-arpeggio-fields ctx)
   (let* ((def (ly:context-grob-definition ctx 'Arpeggio))
          (dir (and (pair? def) (assoc-get 'arpeggio-direction def)))
          (stencil (and (pair? def) (assoc-get 'stencil def))))
     `((arpeggio-direction . ,(if (number? dir) dir 'null))
       (arpeggio-style . ,(cond ((eq? stencil ly:chord-bracket::print) 'bracket)
                                ((eq? stencil ly:chord-slur::print) 'parenthesis)
                                (else 'normal))))))

%% A hairpin's tip (\override Hairpin.circled-tip) and whether \crescTextCresc turned the
%% hairpin into words (crescendoSpanner = 'text, with crescendoText for the words).
#(define (ed-hairpin-fields ctx class)
   (let ((cresc (eq? class 'crescendo-event)))
     `((circled-tip . ,(ed-grob-property ctx 'Hairpin 'circled-tip))
       (spanner-style . ,(ed-value (ly:context-property
                                    ctx (if cresc 'crescendoSpanner 'decrescendoSpanner) 'null)))
       (spanner-text . ,(let ((text (ly:context-property
                                     ctx (if cresc 'crescendoText 'decrescendoText) #f)))
                          (if text (ed-value text) 'null))))))

#(define (ed-note engraver event)
   (ed-guard 'note (lambda () (ed-note-body engraver event))))
#(define (ed-note-body engraver event)
   (let* ((ctx (ly:translator-context engraver))
          (moment (ly:context-current-moment ctx))
          (grace (not (zero? (ly:moment-grace moment)))))
     (ed-push! ctx
               (append `((k . note))
                       (ed-voice-fields engraver)
                       `((d . ,(ed-duration (ly:event-property event 'duration)))
                         (a . ,(list->vector
                                (map ed-articulation
                                     (ly:event-property event 'articulations '()))))
                         (slash . ,(and grace (ed-grace-slash? ctx)))
                         (hidden . ,(ed-hidden-note? ctx))
                         (style . ,(ed-note-style ctx event))
                         (parenthesized . ,(eq? (ed-tweak event 'parenthesized) #t))
                         (stem . ,(ed-stem-direction ctx))
                         (merge . ,(ed-merge-heads? ctx)))
                       (ed-event-alist event)))))

#(define (ed-rest kind engraver event)
   (ed-push! (ly:translator-context engraver)
             (append `((k . ,kind))
                     (ed-voice-fields engraver)
                     `((d . ,(ed-duration (ly:event-property event 'duration))))
                     (ed-event-alist event))))
#(define (ed-rest-event engraver event) (ed-rest 'rest engraver event))
#(define (ed-mmrest-event engraver event) (ed-rest 'mmrest engraver event))
#(define (ed-skip-event engraver event) (ed-rest 'skip engraver event))

%% ties, slurs, scripts, dynamics, pedal, tuplet spans...
#(define (ed-voice-event engraver event)
   (ed-guard (car (ly:event-property event 'class))
             (lambda () (ed-voice-event-body engraver event))))
%% A slur's side is settled at page layout, which we never reach; but \slurUp and friends set
%% the grob's direction property in the context, and that we can read.
#(define (ed-forced-direction ctx class)
   (let* ((grob (cond ((eq? class 'slur-event) 'Slur)
                      ((eq? class 'phrasing-slur-event) 'PhrasingSlur)
                      (else #f)))
          (def (and grob (ly:context-grob-definition ctx grob)))
          (dir (and (pair? def) (assoc-get 'direction def))))
     (if (number? dir) `((grob-direction . ,dir)) '())))

%% A text spanner's words ("rit.", "cresc.") are not on its event but on the TextSpanner
%% grob's bound-details.left.text, set by \override before \startTextSpan.
#(define (ed-text-spanner-text ctx)
   (let* ((spanner (ly:context-grob-definition ctx 'TextSpanner))
          (bounds (and (pair? spanner) (assoc-get 'bound-details spanner)))
          (left (and (pair? bounds) (assoc-get 'left bounds)))
          (text (and (pair? left) (assoc-get 'text left))))
     (if text (ed-markup->string text) "")))

#(define (ed-voice-event-body engraver event)
   (let ((ctx (ly:translator-context engraver))
         (class (car (ly:event-property event 'class))))
     (ed-push! ctx
               (append `((k . ev) (c . ,class))
                       (ed-voice-fields engraver)
                       (ed-event-alist event)
                       ;; \caesura \fermata, \breathe \fermata: the mark rides on the break.
                       (if (memq class '(caesura-event breathing-event))
                           `((a . ,(list->vector
                                    (map ed-articulation
                                         (ly:event-property event 'articulations '())))))
                           '())
                       (cond ((eq? class 'text-span-event)
                              `((text . ,(ed-text-spanner-text ctx))))
                             ((eq? class 'arpeggio-event) (ed-arpeggio-fields ctx))
                             ((memq class '(crescendo-event decrescendo-event))
                              (ed-hairpin-fields ctx class))
                             ((memq class '(sustain-event sostenuto-event))
                              `((pedal-style . ,(ed-value (ly:context-property
                                                           ctx 'pedalSustainStyle 'null)))))
                             ((eq? class 'beam-event)
                              `((grow-direction . ,(ed-grob-property ctx 'Beam 'grow-direction))))
                             (else '()))
                       (ed-forced-direction ctx class)))))

#(define (ed-score-event engraver event)
   (ed-guard (car (ly:event-property event 'class))
             (lambda () (ed-score-event-body engraver event))))
#(define (ed-score-event-body engraver event)
   (ed-push! (ly:translator-context engraver)
             (append `((k . score) (c . ,(car (ly:event-property event 'class))))
                     (ed-event-alist event))))

#(define (ed-staff-event engraver event)
   (ed-push! (ly:translator-context engraver)
             (append `((k . staff) (c . ,(car (ly:event-property event 'class)))
                       (s . ,(ed-context-id (ly:translator-context engraver))))
                     (ed-event-alist event))))

#(define ed-voice-engraver
   (make-engraver
    (listeners
     (note-event . ed-note)
     (rest-event . ed-rest-event)
     (multi-measure-rest-event . ed-mmrest-event)
     (skip-event . ed-skip-event)
     (tie-event . ed-voice-event)
     (slur-event . ed-voice-event)
     (phrasing-slur-event . ed-voice-event)
     (articulation-event . ed-voice-event)
     (fingering-event . ed-voice-event)
     (text-script-event . ed-voice-event)
     (absolute-dynamic-event . ed-voice-event)
     (crescendo-event . ed-voice-event)
     (decrescendo-event . ed-voice-event)
     (sustain-event . ed-voice-event)
     (sostenuto-event . ed-voice-event)
     (una-corda-event . ed-voice-event)
     (tuplet-span-event . ed-voice-event)
     (arpeggio-event . ed-voice-event)
     (trill-span-event . ed-voice-event)
     (text-span-event . ed-voice-event)
     (glissando-event . ed-voice-event)
     (breathing-event . ed-voice-event)
     (tremolo-event . ed-voice-event)
     (tremolo-span-event . ed-voice-event)
     (repeat-tie-event . ed-voice-event)
     (laissez-vibrer-event . ed-voice-event)
     (harmonic-event . ed-voice-event)
     (string-number-event . ed-voice-event)
     (stroke-finger-event . ed-voice-event)
     (caesura-event . ed-voice-event)
     (multi-measure-articulation-event . ed-voice-event)
     (multi-measure-text-event . ed-voice-event)
     (measure-spanner-event . ed-voice-event)
     (note-grouping-event . ed-voice-event)
     (bend-after-event . ed-voice-event)
     (beam-event . ed-voice-event))))

%% Lyrics live in their own context, tied to a Voice by associatedVoiceContext: each
%% syllable is logged with that voice's id, the verse being the Lyrics context itself.
#(define (ed-lyric-event engraver event)
   (ed-guard (car (ly:event-property event 'class))
     (lambda ()
       (let* ((ctx (ly:translator-context engraver))
              (voice (ly:context-property ctx 'associatedVoiceContext #f)))
         (ed-push! ctx
                   (append `((k . lyric) (c . ,(car (ly:event-property event 'class)))
                             (verse . ,(ed-context-id ctx))
                             (voice . ,(if (ly:context? voice) (ed-context-id voice) 'null)))
                           (ed-event-alist event)
                           `((d . ,(ed-duration (ly:event-property event 'duration))))))))))

#(define ed-lyric-engraver
   (make-engraver
    (listeners
     (lyric-event . ed-lyric-event)
     (hyphen-event . ed-lyric-event)
     (extender-event . ed-lyric-event))))

%% Clef and ottava are context properties, not events: sample them each timestep and log
%% changes. Key signatures do arrive as events, at the Staff.
#(define (ed-staff-engraver ctx)
   (let ((last-clef #f) (last-ottava #f) (last-time-style #f))
     (make-engraver
      (listeners
       (key-change-event . ed-staff-event))
      ((stop-translation-timestep engraver)
       (ed-guard 'staff-step
         (lambda ()
           (let ((clef (list (ly:context-property ctx 'clefGlyph)
                             (ly:context-property ctx 'clefPosition)
                             (ly:context-property ctx 'clefTransposition)))
                 (ottava (ly:context-property ctx 'middleCOffset 0))
                 ;; \numericTimeSignature is an override of TimeSignature.style.
                 (time-style (ed-grob-property ctx 'TimeSignature 'style)))
             (when (not (equal? time-style last-time-style))
               (set! last-time-style time-style)
               (ed-push! ctx `((k . timestyle) (s . ,(ed-context-id ctx))
                               (style . ,time-style))))
             (when (not (equal? clef last-clef))
               (set! last-clef clef)
               (ed-push! ctx `((k . clef) (s . ,(ed-context-id ctx))
                               (glyph . ,(ed-value (first clef)))
                               (pos . ,(ed-value (second clef)))
                               (transp . ,(ed-value (third clef))))))
             (when (not (equal? ottava last-ottava))
               (set! last-ottava ottava)
               (ed-push! ctx `((k . ottava) (s . ,(ed-context-id ctx))
                               (offset . ,(ed-value ottava)))))))))
      ((finalize engraver)
       (ed-push! ctx `((k . staffmeta) (s . ,(ed-context-id ctx))
                       (instrument . ,(ed-value (ly:context-property ctx 'instrumentName "")))
                       (short . ,(ed-value (ly:context-property ctx 'shortInstrumentName "")))))))))

#(define (ed-score-engraver ctx)
   (let ((last-step #f) (last-tempo #f))
     (make-engraver
      (listeners
       (tempo-change-event . ed-score-event)
       (time-signature-event . ed-score-event)
       (bar-event . ed-score-event)
       (volta-repeat-start-event . ed-score-event)
       (volta-repeat-end-event . ed-score-event)
       (alternative-event . ed-score-event)
       (volta-span-event . ed-score-event)
       (fine-event . ed-score-event)
       (dal-segno-event . ed-score-event)
       (segno-mark-event . ed-score-event)
       (coda-mark-event . ed-score-event)
       (rehearsal-mark-event . ed-score-event)
       (ad-hoc-mark-event . ed-score-event)
       (text-mark-event . ed-score-event)
       (ad-hoc-jump-event . ed-score-event)
       (section-label-event . ed-score-event)
       (section-event . ed-score-event))
      ((stop-translation-timestep engraver)
       (ed-guard 'score-step
         (lambda ()
           (let ((step (list (ly:context-property ctx 'currentBarNumber)
                             (ly:context-property ctx 'measureLength)
                             (ly:context-property ctx 'timeSignature)
                             ;; \cadenzaOn: timing off, the bar stops counting.
                             (ly:context-property ctx 'timing #t))))
             (when (not (equal? step last-step))
               (set! last-step step)
               (ed-push! ctx `((k . step)
                               (bar . ,(ed-value (first step)))
                               (pos . ,(ed-value (ly:context-property ctx 'measurePosition)))
                               (len . ,(ed-value (second step)))
                               (time . ,(ed-value (third step)))
                               (timing . ,(fourth step)))))
             ;; \tempo is an event, but `\set Score.tempoWholesPerMinute` is only a property.
             (let ((tempo (ly:context-property ctx 'tempoWholesPerMinute #f)))
               (when (and tempo (not (equal? tempo last-tempo)))
                 (set! last-tempo tempo)
                 (ed-push! ctx `((k . tempo) (wholes-per-minute . ,(ed-value tempo))))))))))
      ((finalize engraver)
       (ed-guard 'write-json ed-write-json!)))))

%%% ---------------------------------------------------------------- output

#(define (ed-header-alist . modules)
   (let ((keys '(title subtitle subsubtitle composer arranger poet opus piece copyright
                 source style maintainer license mutopiatitle mutopiacomposer mutopiaopus
                 mutopiainstrument date)))
     (filter-map
      (lambda (key)
        (let ((value (any (lambda (mod)
                            (and (module? mod)
                                 (let ((var (module-variable mod key)))
                                   (and var (variable-bound? var) (variable-ref var)))))
                          modules)))
          (and value (not (null? value)) (cons key (ed-value value)))))
      keys)))

#(define (ed-write-json!)
   (let* ((name (string-append (ly:parser-output-name) ".events.json"))
          (port (open-output-file name)))
     (ed-json `((version . 1)
                (source . ,(basename (ly:parser-lookup 'input-file-name)))
                (lilypond . ,(lilypond-version))
                (header . ,ed-header)
                (contexts . ,(list->vector (reverse ed-contexts)))
                (events . ,(list->vector (reverse ed-events))))
              port)
     (close-port port)
     (ly:progress "lilypond-event-document: wrote ~a (~a events)\n" name (length ed-events))))

%%% ---------------------------------------------------------------- score interception

%% A read-only walk: music-map rewrites the tree as it goes, and a rewritten \repeat unfold
%% no longer unfolds ("Moment is not increasing" in the MIDI pass).
#(define (ed-music-has-notes? music)
   (and (ly:music? music)
        (or (music-is-of-type? music 'note-event)
            (let ((element (ly:music-property music 'element)))
              (and (ly:music? element) (ed-music-has-notes? element)))
            (any ed-music-has-notes? (ly:music-property music 'elements '())))))

%% ly:book-scores and ly:book-book-parts hand back their lists newest first (LilyPond's own
%% book handler reverses them before processing), so both are reversed here to read the file
%% in its written order: a sonatina's first movement, not its last.
#(define (ed-scores-of-book book)
   (append (reverse (filter ly:score? (ly:book-scores book)))
           (append-map ed-scores-of-book (reverse (ly:book-book-parts book)))))

%% A file can hand us several books (each explicit \book, then whatever was left at top
%% level); the first one with a score that has notes is the piece, the rest are ignored.
#(define ed-done #f)

#(define (ed-book-handler book)
   (let* ((scores (ed-scores-of-book book))
          (score (find (lambda (s) (ed-music-has-notes? (ly:score-music s))) scores)))
     (cond
      (ed-done (ly:progress "lilypond-event-document: ignoring a later book\n"))
      ((not score) (ly:progress "lilypond-event-document: no score with notes in this book\n"))
      (else (set! ed-done #t) (ed-import-score score scores)))))

#(define (ed-import-score score scores)
   (begin
     (ly:progress "lilypond-event-document: ~a score(s) in file, importing the first with notes\n"
                  (length scores))
     (set! ed-header (ed-header-alist (ly:score-header score)
                                      (ly:parser-lookup '$defaultheader)))
     ;; Translation only: the engravers above see every event, and no page is ever laid out.
     (ly:run-translator (ly:score-music score) (ed-layout-def score))))

%% The score's \layout block when it has one (it was cloned from $defaultlayout after this
%% file added its engravers, so they are in it), else $defaultlayout. A layout block inside
%% \score reads values that the default lacks, and some translation-time code.
#(define (ed-layout-def score)
   (let ((def (ly:output-def-clone
               (or (find (lambda (def) (eq? (ly:output-def-lookup def 'output-def-kind) 'layout))
                         (ly:score-output-defs score))
                   (ly:parser-lookup '$defaultlayout))))
         (paper (ly:parser-lookup '$defaultpaper)))
     ;; When a book is printed, each score's layout gets the book's paper as its parent, so
     ;; staff-space, line-width and friends resolve. ly:run-translator gets no such parent,
     ;; and some engravers read those values ("expecting real number: #<undefined>"), so copy
     ;; every paper variable the layout does not already define.
     (module-for-each
      (lambda (symbol variable)
        (if (and (variable-bound? variable)
                 (eq? (ly:output-def-lookup def symbol 'ed-unset) 'ed-unset))
            (ly:output-def-set-variable! def symbol (variable-ref variable))))
      (ly:output-def-scope paper))
     def))

#(define toplevel-book-handler ed-book-handler)
#(define default-toplevel-book-handler ed-book-handler)

\layout {
  \context { \Voice \consists #ed-voice-engraver }
  \context { \CueVoice \consists #ed-voice-engraver }
  \context { \DrumVoice \consists #ed-voice-engraver }
  \context { \Staff \consists #ed-staff-engraver }
  \context { \Lyrics \consists #ed-lyric-engraver }
  \context { \DrumStaff \consists #ed-staff-engraver }
  \context { \RhythmicStaff \consists #ed-staff-engraver }
  \context { \Score \consists #ed-score-engraver }
}
