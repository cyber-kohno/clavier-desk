# Editor hand animation

Implemented: 2026-11-16.

## Entry and layout

`Ctrl+P` opens Hand Animation from the editor when no other input or menu is open. Editor audio stops before opening. The view blocks score editing and MCP checkout while open. Its UI is entirely English.

The modal is always **1040 × 720 CSS px**, centered in the main window. The Tauri minimum window remains **1100 × 800**. There are no smaller-screen breakpoints or resize controls. Rows are 48 px for the title, 40 px for generation status, the remaining space for a single Three.js canvas, and 80 px for transport controls. Generation does not change the layout.

## Data flow

`ScoreProject → ScorePlaybackPlan → inspectAnimation → generateAnimation → time-based pose evaluation → scene`

The audio playback plan now carries per-pitch hand, voice, finger, optional substitution finger, original note ID and original pitch index. Upper staff means right hand; lower staff means left hand. This metadata follows grace notes, trill attacks, rolled chord pitches, ties, articulation and fermata timing. Motion consumes the same attack/release times as audio. Pedal events remain separate and do not extend finger contact.

Ordinary tied continuations need no repeated fingering. An explicit finger change inside a tie is rejected. Trills require their own finger sequence for every performed attack. A substitution receives halfway through the performed key-hold duration, with up to 40 ms overlap; it does not cause another audio attack. Unsupported or excessively short handoffs fail generation.

Motion and audio have the same 600 ms preparation lead-in. Full-score duration includes final rests and 620 ms for release/recovery. Playback speed scales the shared timeline rather than replanning motion.

Generation uses the immutable current editor revision. The generated result survives closing and reopening the modal for the lifetime of the app. Reopening after editing marks it as outdated; the old result is still playable until explicitly regenerated. Nothing is added to the project file or editor Undo history. Reopening resets playback and camera to their initial state.

## Validation and errors

Opening shows assigned/total performed attacks. Generate reports missing fingerings with measure, hand, voice, MIDI pitch and original note identity in the underlying diagnostic. At most six issues are shown together, followed by a remaining count. The existing keyboard-operated editor alert dialog is reused.

After coverage passes, the motion engine checks reachability, conflicting finger/key contacts and its supported paths. Failures stop generation and show an English reason, with score location when the engine identifies a passage. The model can reject playable human fingerings; passing is not a guarantee of anatomical feasibility or full collision avoidance. Finger numbers, pitches and performance times are never silently corrected.

## Controls

| Key | Action |
| --- | --- |
| Ctrl+P | Open from the editor |
| Enter | Generate before a result exists; play/pause after generation |
| G | Generate / regenerate |
| Space | Play / pause |
| Arrow keys | Pan in camera screen space |
| Shift+arrow keys | Orbit around the current camera target |
| + / - (also = and numpad + / -) | Zoom in / out |
| Arrow keys, with the playback bar focused | Pause and seek one second |
| Shift+arrow keys, with the playback bar focused | Pause and step 1/60 second |
| Home / End | Pause at the start / end |
| [ / ] | Decrease / increase playback speed |
| R / T | Reset oblique view / top view |
| N | Show / hide falling notes without moving the camera |
| V | Top overview of the note field, 88 keys and hands |
| Tab / Shift+Tab | Move through controls, staying inside the modal |
| Escape | Close; audio and rendering stop |

Native buttons retain their Enter/Space behavior. The playback bar uses arrow keys for seeking; the speed selector retains its native arrow behavior. All controls are reachable with Tab. Camera movement uses held keys and elapsed frame time, so it does not depend on OS key-repeat speed. Diagonal movement is normalized. Releasing keys stops keyboard movement; focus changes, window blur, hidden tabs and error dialogs clear held keys. Camera orbit, zoom and pan also remain available through mouse interaction. Errors restore modal focus after dismissal.

## Falling notes

The single 3D scene includes a note field behind the keyboard. Bars travel toward a strike line at the keyboard's rear edge, aligned with each key's X position. The initial camera and `R` use an oblique view including the note field; `T` is a close top view of the keyboard, and `V` is a top overview including notes. All presets and free camera movement use the same scene and renderer. Toggling notes or regenerating does not reset the camera.

The field previews three performance seconds at 0.24 m/s. Notes are clipped at the far end. The leading edge reaches the strike line at the performed attack time, including the shared 600 ms lead-in. During key hold, the remaining bar stays at the line and shortens until release. Left-hand bars are blue and right-hand bars orange; held bars use a lighter color. Lane centers share the keyboard geometry, and widths leave space between adjacent black/white key lanes. There is no bloom, particle or afterimage effect.

Bars derive from the generated snapshot's shared audio attacks, not motion contact events: a substitution remains one bar, and tied notes remain one hold. Per-pitch releases, ornaments and fermata timings follow the existing common plan. Pedal sustain does not extend the bars. Time-based evaluation handles pause, speed changes and forward/backward seeks without accumulating position.

Only notes overlapping the visible time window are instantiated. The implementation indexes expired prefixes, clips long held notes and batches bars into one `InstancedMesh`, growing its buffer only when the visible count requires it. Notes have normal 3D depth and perspective: rotation can make the field oblique or edge-on. The `V` preset restores a readable overview. Hidden notes skip frame calculation and drawing; closing disposes the renderer's geometry, materials and instance resources.

## Implementation and current limits

The geometric engine in `code/apps/editor/src/domain/motion` is adapted from `prototypes/3d-motion-lab/src`. The production scene is separate under `infra/motion`; it uses one renderer and one camera. Prototype comparison controls, debug markers and auxiliary hand views are omitted. Three.js is loaded when the modal opens and disposed when it closes.

The prototype's simple hand/finger/forearm geometry and reachability limitations remain. There is no imported realistic hand mesh, automatic fingering, full-body IK, complete hand-to-hand collision avoidance, anatomical speed check, camera keyframe authoring, video export or persisted animation artifact. Geometric preparation currently runs on the main thread after the generating state has painted; long and dense scores may block interaction while preparing. This is a follow-up performance boundary to measure with real scores.

Seeking restarts currently held audio notes and restores pedal state. It does not reconstruct the decay of already-released pedal-sustained notes. Audio uses the instrument clock when available; a failed or unavailable audio initialization permits silent animation playback. The view reports playback failures instead of advancing the visuals independently of failed audio.

## Initial integration verification

- Type checking: zero errors; three existing warnings in App/EditorDialog.
- Production build: successful. The renderer is a separately loaded chunk.
- New conversion/transport tests: 9/9 passed.
- Full editor suite: 477/500 passed. The same 23 failures occur on the pre-change source in an isolated temporary checkout; no new failures.
- All 17 prototype score fixtures normalize and generate successfully with the migrated engine. Evaluated 1,767 event-boundary poses for finite positions/rotations and checked deterministic reverse seeks.
- Browser UI: verified a 1040 × 720 modal at a 1100 × 800 viewport, one canvas, keyboard generation, empty-score error, audio playback, seeking, speed change, camera presets, focus wrapping, result retention and outdated-score notification. The user's native score was not modified for these checks.

## Keyboard camera verification

Added 2026-11-16. Camera movement shares the existing OrbitControls target with mouse interaction. Zoom distance is limited to 0.08–8 m; rotation avoids the polar singularities. The main keyboard's `=` also zooms in without requiring Shift. Both numpad zoom keys are supported.

- Camera tests: 5/5 passed, covering screen-space pan invariants, fixed-target orbit, top-view limits, zoom bounds, frame-rate independence, diagonal speed and physical key release/reset.
- Related animation tests: 9/9 passed. Type checking and production build passed, with the same three existing type-check warnings.
- Browser at 1100 × 800: verified held-key pan, Shift+arrow orbit, zoom in/out, reset, and playback-bar focus routing. Right then Shift+Right on the focused playback bar moved from 0 to 1 + 1/60 seconds; camera shortcuts left playback time unchanged. Tests used a disposable browser score, without changing the native user's score.

## Falling-note verification

Added 2026-11-16. Six new tests cover attack/release boundaries, clipped long holds and future notes, reverse seeks, all 88 lane alignments and non-overlap, per-pitch releases, substitution/pedal semantics, a dense 300-bar instance window and overview framing. All 20 related animation/camera/note-stream tests pass. Type checking and production build pass with the same existing warnings.

Browser verification at 1100 × 800 used a disposable three-note score. Verified synchronized playback, a held bar at the strike line at 1 second, note visibility without a camera or time change, and rotation/zoom with notes and hands remaining in the same 3D scene. The native user's score was not edited.

## Camera orientation correction — 2026-11-17

The falling-note integration had changed the initial view to directly overhead, so horizontal orbit appeared to spin the keyboard in the image plane. The initial view is oblique again, with the note field included. Top presets also now preserve the world Y-up axis used by OrbitControls, avoiding roll when tilting and orbiting after a top view. A near-imperceptible tilt avoids the exact overhead lookAt singularity. Shift+Left/Right still controls azimuth; Shift+Up/Down controls elevation. Added a regression test for level horizontal orbit before and after switching presets.
