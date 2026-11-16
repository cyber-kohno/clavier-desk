# Automatic fingering

Implemented: 2026-11-17.

## Entry and interaction

Select a continuous note range in one staff and voice, press `M`, then choose
`Fingering > Auto Assign…`. Every chord pitch is included, irrespective of the
currently focused pitch. Existing ordinary fingers are immutable anchors; only
missing fingers are filled. There is no separate starting-finger setting.

The dedicated modal has confirmation, calculation, and result states. It shows
the selected hand, voice, measure range, fixed/missing pitch counts, diagnostics,
and one proposed result as a pitch/finger table. No score preview, options, or
alternative-draft selector is exposed in this first version. Calculation does
not edit the score. Apply writes the whole draft in one Undo entry. Close,
Escape, and cancelling a running calculation never apply a partial result.
Escape during calculation terminates the worker and returns to confirmation.
The editor and MCP checkout are blocked while the modal is open. Application
shortcuts do not run behind the modal. Left/Right selects enabled footer choices
(clamped at either end), Enter executes the focused choice, and Up/Down scrolls
the result list/details by 48 CSS pixels per key event, including key repeat.
The modal is 720 × 640 CSS pixels in every phase, constrained only by a 24-pixel
margin on smaller viewports. Title, selection counts, result summary, footer
choices and keyboard hint stay fixed. The remaining central area scrolls the
result table and detailed warnings/errors; column headings stay sticky. There
is no nested scroll area or visible scrollbar. Tab navigation and mouse
activation remain available.
Apply also checks the immutable source revision.

`Fingering > Clear` removes ordinary fingers, substitutions, and attached grace
fingers from the selected notes in one Undo entry. It removes a trill's finger
sequence only when its complete span is selected; a partial selection of an
annotated trill disables Clear with a reason. Trill settings and every other
musical property remain unchanged. Clear is disabled if there is nothing to clear.

## Scope

Only selected notes influence fingering. No outside pitch, finger, voice,
articulation or fermata constrains the result. The source score is never edited
to build the calculation input. A detached score retains the selected notes,
the rests between them, and their written/tuplet timing. Other notes become
rests; other voices and pedal events are absent. Boundary transitions are not
checked. A slur is retained only if both endpoints are selected. Tempo uses the
project's initial tempo plus tempo marks anchored to selected notes; outside
tempo marks are deliberately excluded by the range-only contract. Consequently,
range validation does not guarantee animation of the full score, including its
global timing and boundary contacts.

Supported: ordinary notes, simultaneous chords of up to five pitches, rests,
tuplets, staccato, internal slurs and selected-note fermatas. A complete ordinary
tie chain is one held contact; its head owns the finger and continuations inherit
it without storing or displaying duplicate numbers. The dialog counts and lists
performed attacks/chords, rather than every written tie member. A legacy fixed
finger on a continuation constrains the same contact, provided all annotations
agree. Missing fingers are filled only on the attack/head.
Selection must include both ends of every tie it touches. Grace notes, trills,
rolled chords, and existing held-note substitutions are explicitly rejected by
Auto Assign for now, rather than skipped or partially processed. These remain
manually editable, and Clear supports their existing finger data as above.

## Engine and boundaries

- `domain/score/fingering-selection.ts`: resolve/validate selection, inspect
  anchors and coverage, perform atomic fill/clear. Preserve IDs and timing.
- `domain/performance/fingering-passage.ts`: create detached selected-note
  playback; use the existing performance interpretation for attack/release
  timing and merge tie targets.
- `domain/performance/automatic-fingering.ts`: deterministic bounded beam
  search over complete chord finger combinations; use keyboard geometry, hand
  orientation, fixed anchors, chord reach and finger order. Rank transitions by
  hand displacement, finger crossings, black-key use, repeated-key reset and
  available movement time. This is a configurable-code heuristic, not a trained
  model, a unique correct fingering, or a global optimality guarantee.
- `infra/fingering/fingering-worker.ts` and
  `service/fingering/fingering-calculation.ts`: worker execution, progress,
  completion/error lifecycle and termination on cancellation/unmount.
- `action/editor/fingering-editor.ts`: commit fill and clear through the existing
  editing transaction. The UI owns the single history entry.

Search keeps up to 96 paths with alternatives for recent finger combinations.
It accepts up to 4096 performed attacks and validates up to 16 complete candidates
using the current motion engine's `validate` and `preparePerformance`. The first
passing candidate is returned in a candidate array, allowing later multiple
drafts without changing the result contract. Failure to find a candidate within
these bounds is reported as a search/model limitation, not human impossibility.

Warnings mark positions with a heuristic local cost of at least 4 (movement,
stretch/crossing plus chord/finger cost). They are review locations, not a
probability, confidence score or count of incorrect fingers. They do not claim
anatomical accuracy beyond the current animation model.

## Verification

Tests cover unannotated scale search and thumb crossing, middle/end anchors,
left/right chord order and animation, isolation from outside notes and voices,
rest/tuplet timing, complete/partial/conflicting ties, unsupported expressions,
atomic rejection of invalid drafts, ordinary/grace/substitution/trill clearing,
Undo/Redo, submenu navigation, and worker cancellation/late-message cleanup.

Verification on 2026-11-17: all 14 new engine/lifecycle tests and all 55 related
tests passed. `pnpm check` passed with the three existing warnings; `pnpm build`
passed, including the separate worker asset. Full suite: 527 passed, 23 failed
out of 550. An isolated HEAD baseline with its original fixtures had the exact
same 23 failing test names (488 passed out of 511); no new failures were added.
The other pre-existing uncommitted MusicXML tests were retained; their App
function harness was extended with the new modal state variable.

Browser UI verification used a separate disposable score: four ascending notes
with the second finger fixed produced a draft with one fixed and three new
fingers; Apply, Clear, separate single-step Undo operations, and closing a result
without applying all behaved as specified. The current hand model passed the
selected-passage validation. Result layout was visually inspected.

Keyboard revision: verified the complete confirmation/calculation/result/apply
flow using only keys, Left/Right focus changes, Back, and disabled-choice
skipping. A 12-note result scrolled down from 0 to 181 px and back to 85 px
with arrow keys while Apply retained focus; computed scrollbar width was `none`.
Type checking and production build passed with the existing warnings.

## Tie fingering ownership

`domain/score/tie-fingerings.ts` centralizes the ordinary tie's attack owner,
legacy interpretation, normalization and inheritance after a split/deletion.
Appending or rhythmically re-spelling ties stores initial/substitution fingers
only at the head. Editing from any member targets that owner and uses the head's
chord/grace finger constraints. Removing a link materializes the original initial
finger at each new attack; a substitution remains on its original attack.
Copying a detached suffix also materializes its new head's inherited initial
finger. Joining previously independent attacks with conflicting fingers is
rejected rather than discarding either annotation.

Project loading migrates safe duplicates (including a unique legacy initial
finger stored only on continuations). Conflicting initial fingers, reuse of one
finger across combined chord annotations, or a substitution stored only on a
continuation are retained and diagnosed by Auto Assign/animation. Explicit
manual edits or complete-chain Clear can resolve them. There is no file format
version change: optional per-pitch fields remain compatible, with a single
canonical owner. Undo retains the original snapshot. Clear, like Auto Assign,
requires every member of a selected ordinary tie.

Verification: 11 tie-ownership tests cover editing from either hand, chord finger
constraints, extension/re-spelling, split/head deletion, joining conflicts,
one-attack auto assignment and animation, legacy loading/normalization, detached
copying, complete-chain Clear/Undo, and MCP batch editing. All pass. Full suite:
539 passed and the same 23 existing failures remain (562 total). Two older tests
that explicitly expected copied fingers on continuations now assert head-only
storage. UI verification edited a tied tail from 1 to 3 and observed a single
head badge; selecting both written notes then generated one attack/assignment
and retained only one badge after applying. Type checking and build pass with
the existing warnings.

Direct `W` editing accepts an empty/whitespace-only draft and clears ordinary
initial/substitution fingers together on Enter, including when invoked from a
tied continuation. Grace and trill inputs share empty-to-clear behavior. Escape
discards the draft; empty confirmation on an already unassigned pitch creates no
history entry. The floating field displays an Apply/Clear/Cancel hint. Three
new parsing/actual-App-handler tests cover blank acceptance, invalid text,
ordinary/tie/grace deletion, cancellation and Undo/Redo; all 24 related tests,
type checking and build pass. Browser verification confirmed that blank text has
no error styling, Enter removes a `1-2` fingering, and one Undo restores `1-2`.

Fixed-layout revision: confirmation and results for 1 and 16 notes measured
720 × 640 px. Scrolling the 16-note list by 288 px left title, counts, result
summary and footer coordinates unchanged; column headings stayed at the list
top. Wheel scrolling also moved only the list. Scrollbars remained hidden, and
type checking and the production build passed with the existing warnings.
