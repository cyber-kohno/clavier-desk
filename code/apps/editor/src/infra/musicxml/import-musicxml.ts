import Factory from '../../domain/score/score-project.ts';
import Validator from '../../domain/score/score-project-validator.ts';
import Voice from '../../domain/score/score-voice.ts';
import RestSpelling from '../../domain/score/rest-spelling.ts';
import WrittenValue from '../../domain/theory/written-value.ts';
import PitchSpelling from '../../domain/theory/pitch-spelling.ts';
import ScoreGlissando from '../../domain/score/score-glissando.ts';
import type { Glissando, GlissandoEndpoint, KeySignature, NoteValue, PianoNote, PianoPitch, PianoRest, PianoStaff, PianoVoiceElement, ScoreProject } from '../../domain/score/types.ts';

export type ImportWarning = { code: string; message: string; measure?: number; count: number };
export type MusicXmlImportResult = { project: ScoreProject; warnings: ImportWarning[] };
type TupletMark = { type: string; number: string };
type GlissandoMark = {
  kind: string | null; number: number; measure: number; lineType?: Glissando['lineType']; text?: string;
  endpoint?: GlissandoEndpoint; position?: number;
};
type Event = { start: number; duration: number; value?: NoteValue; pitches: PianoPitch[];
  ratio?: { actual: number; normal: number; normalType: string }; tuplets: TupletMark[]; tieStart: boolean; tieStop: boolean;
  glissandi: { mark: GlissandoMark; midi: number }[] };
const EPSILON = 1e-8;
const near = (a: number, b: number) => Math.abs(a - b) < EPSILON;
const children = (node: Element, name?: string): Element[] => Array.from(node.childNodes)
  .filter((child): child is Element => child.nodeType === 1 && (!name || (child as Element).localName === name));
const child = (node: Element, name: string) => children(node, name)[0];
const text = (node: Element, name: string) => child(node, name)?.textContent?.trim() ?? '';
const number = (node: Element, name: string) => text(node, name) === '' ? NaN : Number(text(node, name));
const positive = (n: number) => Number.isFinite(n) && n > 0;
const id = () => crypto.randomUUID();

function readTuplet(events: readonly Event[], start: number) {
  const first = events[start];
  const { actual, normal, normalType } = first.ratio!;
  const opening = first.tuplets.find(mark => mark.type === 'start');
  const bases = WrittenValue.entries();
  const fallback = bases.find(([type]) => type === (normalType || first.value?.type));
  const expected = fallback ? fallback[1] * actual : 0;
  let position = first.start, written = 0;
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (!event.value || event.ratio?.actual !== actual || event.ratio.normal !== normal ||
      !near(event.start, position)) break;
    const length = WrittenValue.sixteenths(event.value);
    if (!near(event.duration, length * normal / actual)) break;
    written += length;
    position += event.duration;
    const closing = event.tuplets.find(mark => mark.type === 'stop');
    if (event.tuplets.some(mark => (i !== start || mark !== opening) && mark !== closing)) break;
    if (opening) {
      // Brackets delimit mixed values and consecutive groups with the same ratio.
      if (!closing) continue;
      const base = bases.find(([, length]) => near(length * actual, written));
      if (closing.number === opening.number && base) return { baseType: base[0], end: i };
      break;
    }
    if (closing || !fallback || written > expected + EPSILON) break;
    if (near(written, expected)) return { baseType: fallback[0], end: i };
  }
  throw new Error('Unsupported tuplet');
}

namespace ImportMusicXml {
  /** Browser DOMParser does not fetch the external MusicXML DTD. Internal entities are unsupported. */
  export function parse(source: string): MusicXmlImportResult {
    if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(source)) throw new Error('XML entity declarations are not supported.');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.getElementsByTagName('parsererror').length) throw new Error('The file is not well-formed XML.');
    return convert(document);
  }

  export function convert(document: Document): MusicXmlImportResult {
    const root = document.documentElement;
    if (!root || root.localName !== 'score-partwise') throw new Error('Expected an uncompressed score-partwise MusicXML file.');
    const warnings: ImportWarning[] = [];
    const warn = (code: string, message: string, measure?: number) => {
      const previous = warnings.find(item => item.code === code && item.message === message && item.measure === measure);
      if (previous) previous.count++;
      else warnings.push({ code, message, measure, count: 1 });
    };
    const parts = children(root, 'part');
    const hasGrandStaff = (part: Element) => Array.from(part.getElementsByTagName('*')).some(element =>
      element.localName === 'staves' && Number(element.textContent) === 2) ||
      [1, 2].every(staff => Array.from(part.getElementsByTagName('*')).some(element =>
        element.localName === 'staff' && Number(element.textContent) === staff));
    const part = parts.find(hasGrandStaff) ?? parts.find(item => item.getElementsByTagName('note').length) ?? parts[0];
    if (!part) throw new Error('No score part was found.');
    if (!hasGrandStaff(part)) warn('grand-staff', 'A two-staff part could not be confirmed. Available staves were assigned to the piano grand staff.');
    if (parts.length > 1) warn('parts', 'Only the selected part was imported; other parts were omitted.');
    const measures = children(part, 'measure');
    if (!measures.length) throw new Error('No measures were found in the selected part.');

    const project = Factory.create();
    const initial = project.outline[0].data;
    const scorePart = children(child(root, 'part-list') ?? root, 'score-part').find(item => item.getAttribute('id') === part.getAttribute('id'));
    project.outline[1].data.name = scorePart ? text(scorePart, 'part-name') || 'Imported' : 'Imported';
    let divisions = 1, meter = { cnt: 4, unit: 4 }, fifths: KeySignature['fifths'] = 0, transpose = 0;
    const voiceIds = [new Map<string, string>(), new Map<string, string>()];
    const pendingTies = new Map<string, { note: PianoNote; end: number }>();
    const glissandoMarks: GlissandoMark[] = [];
    let measureStart = 0;
    const written = (node: Element): NoteValue | undefined => {
      const type = text(node, 'type') as NoteValue['type'];
      const dots = children(node, 'dot').length;
      return WrittenValue.entries().some(([name]) => name === type) && dots <= 2 ? { type, dots } : undefined;
    };
    const pitch = (node: Element, measure: number): PianoPitch[] => {
      const p = child(node, 'pitch');
      if (!p) { if (!child(node, 'rest')) warn('pitch', 'Unpitched or missing pitches were omitted.', measure); return []; }
      const natural = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[text(p, 'step')];
      const alter = child(p, 'alter') ? number(p, 'alter') : 0;
      const octave = number(p, 'octave');
      const midi = (octave + 1) * 12 + natural + alter + transpose;
      if (!Number.isInteger(octave) || !Number.isInteger(midi)) { warn('pitch', 'Invalid or microtonal pitches were omitted.', measure); return []; }
      if (midi < 21 || midi > 108) { warn('range', 'Pitches outside A0–C8 were omitted; their timing was retained.', measure); return []; }
      for (const direction of [undefined, 'up', 'down'] as const) {
        const spelling = PitchSpelling.forPreview(midi, { fifths }, direction);
        if (transpose === 0 && spelling.step === text(p, 'step') && spelling.alter === alter && spelling.octave === octave)
          return [direction ? { midi, spellingDirection: direction } : { midi }];
      }
      warn('spelling', 'Some pitch spellings were normalized without changing their sounding pitch.', measure);
      return [{ midi }];
    };

    measures.forEach((measure, index) => {
      const location = index + 1;
      const marksByNote = new Map<Element, GlissandoMark[]>();
      for (const note of children(measure, 'note')) {
        const marks = children(note, 'notations').flatMap(notation => children(notation, 'glissando').map(element => {
          const line = element.getAttribute('line-type');
          const mark: GlissandoMark = {
            kind: element.getAttribute('type'), number: Number(element.getAttribute('number') || '1'), measure: location,
            lineType: line === 'solid' || line === 'dashed' || line === 'dotted' || line === 'wavy' ? line : undefined,
            text: element.textContent?.trim() || undefined,
          };
          return mark;
        }));
        if (marks.length) { marksByNote.set(note, marks); glissandoMarks.push(...marks); }
      }
      let cursor = 0, maximum = 0, timingInvalid = false;
      const streams = [new Map<string, Event[]>(), new Map<string, Event[]>()];
      let previous: { event: Event; staff: number; voice: string } | undefined;
      for (const node of children(measure)) {
        switch (node.localName) {
          case 'attributes': {
            if (child(node, 'divisions')) {
              const next = number(node, 'divisions');
              if (Number.isSafeInteger(next) && next > 0) divisions = next;
              else { timingInvalid = true; warn('timing', 'Invalid divisions; this measure was replaced with rests.', location); }
            }
            const key = child(node, 'key');
            if (key) {
              const next = number(key, 'fifths');
              if (Number.isInteger(next) && next >= -7 && next <= 7 && near(cursor, 0)) {
                if (index === 0) initial.keySignature.fifths = next as KeySignature['fifths'];
                else if (next !== fifths) project.outline.push({ id: id(), type: 'key-change', data: { keySignature: { fifths: next as KeySignature['fifths'] } } });
                fifths = next as KeySignature['fifths'];
              } else warn('key', 'An unsupported key signature or mid-measure key change was omitted.', location);
            }
            const time = child(node, 'time');
            if (time) {
              const cnt = number(time, 'beats'), unit = number(time, 'beat-type');
              if (children(time, 'beats').length === 1 && Number.isInteger(cnt) && cnt >= 1 && cnt <= 256 && [1, 2, 4, 8, 16, 32, 64].includes(unit) && near(cursor, 0)) {
                if (index === 0) initial.timeSignature = { cnt, unit };
                else if (cnt !== meter.cnt || unit !== meter.unit) warn('meter', 'Measure lengths were retained, but time-signature changes cannot be displayed.', location);
                meter = { cnt, unit };
              } else warn('meter', 'An unsupported time signature was replaced by the previous/default meter.', location);
            }
            const transposition = child(node, 'transpose');
            if (transposition) {
              const chromatic = number(transposition, 'chromatic');
              const octave = child(transposition, 'octave-change') ? number(transposition, 'octave-change') : 0;
              if (Number.isInteger(chromatic) && Number.isInteger(octave)) transpose = chromatic + octave * 12;
              warn('transpose', 'Transposing notation was converted to sounding piano pitches.', location);
            }
            if (number(node, 'staves') > 2) warn('staves', 'Staves beyond the first two were omitted.', location);
            for (const clef of children(node, 'clef')) {
              const staff = clef.getAttribute('number') === '2' ? 2 : 1;
              if (index !== 0 || text(clef, 'sign') !== (staff === 1 ? 'G' : 'F') || number(clef, 'line') !== (staff === 1 ? 2 : 4) || child(clef, 'clef-octave-change'))
                warn('clef', 'Clefs were normalized to treble above and bass below; sounding pitches were retained.', location);
            }
            break;
          }
          case 'backup': case 'forward': {
            const duration = number(node, 'duration') * 4 / divisions;
            if (!positive(duration)) {
              timingInvalid = true;
              warn('timing', 'Invalid timing; this measure was replaced with rests.', location);
            }
            else {
              cursor += node.localName === 'backup' ? -duration : duration;
              if (cursor < -EPSILON) {
                timingInvalid = true;
                warn('timing', 'A backup before the measure start was replaced with rests for this measure.', location);
              }
              maximum = Math.max(maximum, cursor);
            }
            previous = undefined;
            break;
          }
          case 'note': {
            if (child(node, 'grace')) { warn('grace', 'Grace notes were omitted.', location); previous = undefined; break; }
            let value = written(node);
            const modification = child(node, 'time-modification');
            const ratio = modification ? { actual: number(modification, 'actual-notes'), normal: number(modification, 'normal-notes'),
              normalType: text(modification, 'normal-type') } : undefined;
            const validRatio = ratio && Number.isInteger(ratio.actual) && ratio.actual >= 2 && ratio.actual <= 64 && Number.isInteger(ratio.normal) && ratio.normal >= 1 && ratio.normal <= 64;
            let duration = number(node, 'duration') * 4 / divisions;
            if (!positive(duration) && !child(node, 'duration') && value && (!ratio || validRatio)) {
              duration = WrittenValue.sixteenths(value) * (ratio ? ratio.normal / ratio.actual : 1);
              warn('duration', 'Missing note durations were inferred from written values.', location);
            }
            if (!positive(duration)) { timingInvalid = true; warn('timing', 'Invalid note timing; this measure was replaced with rests.', location); break; }
            if ((!ratio || validRatio) && (!value || !near(duration, WrittenValue.sixteenths(value) * (ratio ? ratio.normal / ratio.actual : 1))) && !child(node, 'rest')?.getAttribute('measure')) {
              const writtenDuration = duration * (ratio ? ratio.actual / ratio.normal : 1);
              const inferred = WrittenValue.entries().flatMap(([type]) => [0, 1, 2].map(dots => ({ type, dots })))
                .find(candidate => near(WrittenValue.sixteenths(candidate), writtenDuration));
              if (inferred) {
                value = inferred;
                warn('duration', 'Written values were inferred or normalized to preserve the MusicXML durations.', location);
              }
            }
            const staff = child(node, 'staff') ? number(node, 'staff') : 1;
            const voice = text(node, 'voice') || '1';
            const chord = !!child(node, 'chord');
            const start = chord && previous ? previous.event.start : cursor;
            const pitches = pitch(node, location);
            const glissandi = pitches.length ? (marksByNote.get(node) ?? []).map(mark => ({ mark, midi: pitches[0].midi })) : [];
            const ties = children(node, 'tie');
            const tieStart = ties.some(tie => tie.getAttribute('type') === 'start');
            const tieStop = ties.some(tie => tie.getAttribute('type') === 'stop');
            const notation = child(node, 'notations');
            const tuplets = notation ? children(notation, 'tuplet').map(node => ({
              type: node.getAttribute('type') ?? '', number: node.getAttribute('number') || '1',
            })) : [];
            if (children(node, 'notations').some(notations => children(notations).some(item =>
              !['tied', 'tuplet', 'glissando'].includes(item.localName))))
              warn('notation', 'Unsupported articulations, ornaments, slurs or technical markings were omitted.', location);
            if (child(node, 'lyric')) warn('lyrics', 'Lyrics were omitted.', location);
            if (staff === 1 || staff === 2) {
              if (!voiceIds[staff - 1].has(voice) && voiceIds[staff - 1].size < 3) voiceIds[staff - 1].set(voice, `voice-${voiceIds[staff - 1].size}`);
              if (!voiceIds[staff - 1].has(voice)) warn('voices', 'Voices beyond the first three on each staff were omitted.', location);
              else if (chord) {
                if (previous && previous.staff === staff && previous.voice === voice && near(previous.event.duration, duration)) {
                  const event = previous.event;
                  if (event.tieStart !== tieStart || event.tieStop !== tieStop) warn('tie', 'Partial-chord ties cannot be represented and were omitted.', location);
                  event.tieStart &&= tieStart; event.tieStop &&= tieStop;
                  event.pitches.push(...pitches);
                  event.glissandi.push(...glissandi);
                  for (const mark of tuplets) {
                    if (!event.tuplets.some(existing => existing.type === mark.type && existing.number === mark.number))
                      event.tuplets.push(mark);
                  }
                } else warn('chord', 'An incompatible or cross-staff chord tone was omitted.', location);
              } else {
                const event: Event = { start, duration, value, pitches, ratio: validRatio ? ratio : undefined, tuplets, tieStart, tieStop, glissandi };
                // Duration is authoritative; unsupported written values are handled by the voice fallback.
                if (modification && !validRatio) event.value = undefined;
                const stream = streams[staff - 1].get(voice) ?? [];
                stream.push(event); streams[staff - 1].set(voice, stream);
                previous = { event, staff, voice };
              }
            } else warn('staves', 'Notes on unsupported staves were omitted.', location);
            if (!chord) cursor += duration;
            maximum = Math.max(maximum, start + duration, cursor);
            break;
          }
          case 'direction': {
            const sound = child(node, 'sound');
            const metronome = child(child(node, 'direction-type') ?? node, 'metronome');
            const bpm = sound?.getAttribute('tempo') ? Number(sound.getAttribute('tempo')) : NaN;
            const beat = metronome ? text(metronome, 'beat-unit') as NoteValue['type'] : undefined;
            const quarterBpm = positive(bpm) ? bpm : metronome && beat && WrittenValue.entries().some(([type]) => type === beat)
              ? number(metronome, 'per-minute') * WrittenValue.sixteenths({ type: beat, dots: children(metronome, 'beat-unit-dot').length }) / 4 : NaN;
            if (index === 0 && near(cursor, 0) && positive(quarterBpm)) {
              const tempo = Math.round(quarterBpm / (meter.unit === 8 && meter.cnt >= 6 && meter.cnt % 3 === 0 ? 1.5 : 1));
              initial.tempo = Math.max(10, Math.min(400, tempo));
              if (initial.tempo !== tempo) warn('tempo', 'The initial tempo was limited to 10–400.', location);
              if (children(node, 'direction-type').some(type => children(type).some(item => item.localName !== 'metronome')))
                warn('direction', 'Other directions, text, dynamics, pedals or octave lines were omitted.', location);
            } else warn('direction', 'Directions, tempo changes, text, dynamics, pedals or octave lines were omitted.', location);
            break;
          }
          case 'barline':
            if (child(node, 'repeat') || child(node, 'ending')) warn('repeat', 'Repeats and endings were not expanded; measures were imported once in written order.', location);
            break;
          case 'print': break;
          default: warn('element', 'Unsupported measure elements were omitted.', location);
        }
      }
      let length = { ...meter };
      const nominal = meter.cnt * 16 / meter.unit;
      if (measure.getAttribute('implicit') === 'yes' && positive(maximum) && maximum < nominal) {
        const units = maximum * 64;
        if (near(units, Math.round(units))) {
          const numerator = Math.round(units);
          let cnt = numerator, unit = 1024;
          while (unit > 1 && cnt % 2 === 0) { cnt /= 2; unit /= 2; }
          if (unit <= 64 && cnt <= 256) length = { cnt, unit };
          else { timingInvalid = true; warn('pickup', 'An unsupported pickup length was padded to the current meter.', location); }
        }
      }
      const measureDuration = length.cnt * 16 / length.unit;
      const empty = (): PianoVoiceElement[] => [{ id: id(), kind: 'measure-rest' }];
      const tiesToApply: { scope: string; note: PianoNote; event: Event }[] = [];
      const staff = (staffIndex: number): PianoStaff => {
        const voices = Array.from(voiceIds[staffIndex], ([source, voiceId]) => {
          const scope = `${staffIndex}:${source}`;
          const events = streams[staffIndex].get(source) ?? [];
          const importedTies: typeof tiesToApply = [];
          if (timingInvalid || !events.length) {
            if (pendingTies.delete(scope)) warn('tie', 'An incomplete tie was omitted.', location);
            return { id: voiceId, elements: empty() };
          }
          try {
            let position = 0;
            const elements: PianoVoiceElement[] = [];
            const rests = (start: number, duration: number) => RestSpelling.create(
              near(start * 2, Math.round(start * 2)) ? Math.round(start * 2) / 2 : start,
              near(duration * 2, Math.round(duration * 2)) ? Math.round(duration * 2) / 2 : duration);
            const makeNote = (event: Event): PianoVoiceElement => {
              if (!event.value) throw new Error('Unsupported note value');
              const pitches = [...new Map(event.pitches.map(p => [p.midi, p])).values()].sort((a, b) => b.midi - a.midi);
              if (!pitches.length) return { id: id(), kind: 'rest', value: event.value };
              const note: PianoNote = { id: id(), kind: 'note', value: event.value, pitches };
              importedTies.push({ scope, note, event });
              return note;
            };
            for (let i = 0; i < events.length; i++) {
              const event = events[i];
              if (event.start < position - EPSILON || event.start + event.duration > measureDuration + EPSILON) throw new Error('Overlapping or overflowing voice');
              if (event.start > position + EPSILON) elements.push(...rests(position, event.start - position));
              if (event.ratio) {
                const { actual, normal } = event.ratio;
                const { baseType, end } = readTuplet(events, i);
                const group = events.slice(i, end + 1);
                const tuplet = { id: id(), kind: 'tuplet' as const, actual, normal, baseType, elements: group.map(makeNote) as (PianoNote | PianoRest)[] };
                Voice.time(tuplet, length);
                elements.push(tuplet);
                position = group.at(-1)!.start + group.at(-1)!.duration;
                i = end;
              } else {
                if (!event.value || !near(WrittenValue.sixteenths(event.value), event.duration)) {
                  // A measure rest need not have a written type.
                  if (!event.pitches.length && near(event.start, 0) && near(event.duration, measureDuration) && events.length === 1) {
                    elements.push(...empty()); position = measureDuration; continue;
                  }
                  throw new Error('Unsupported written duration');
                }
                elements.push(makeNote(event)); position = event.start + event.duration;
              }
            }
            if (position < measureDuration - EPSILON) elements.push(...rests(position, measureDuration - position));
            tiesToApply.push(...importedTies);
            return { id: voiceId, elements };
          } catch {
            if (pendingTies.delete(scope)) warn('tie', 'An incomplete tie was omitted.', location);
            warn('voice-fallback', 'An unsupported rhythm, tuplet or overlap was replaced with rests for this voice and measure; other voices were retained.', location);
            return { id: voiceId, elements: empty() };
          }
        });
        return { voices: voices.length ? voices : [{ id: 'voice-0', elements: empty() }] };
      };
      const upperStaff = staff(0), lowerStaff = staff(1);
      const seen = new Set<string>();
      for (const { scope, note, event } of tiesToApply) {
        for (const { mark, midi } of event.glissandi) {
          mark.endpoint = { noteId: note.id, midi };
          mark.position = measureStart + event.start;
        }
        seen.add(scope);
        const pending = pendingTies.get(scope);
        // Rest gaps, dropped notes and partial-chord ties must never join unrelated attacks.
        if (pending && event.tieStop && near(pending.end, measureStart + event.start) && pending.note.pitches.length === note.pitches.length && pending.note.pitches.every((p, i) => p.midi === note.pitches[i].midi)) {
          pending.note.tieTo = note.id; note.tieFrom = pending.note.id;
        } else if (pending || event.tieStop) warn('tie', 'An incomplete or unsupported tie was omitted.', location);
        pendingTies.delete(scope);
        if (event.tieStart) pendingTies.set(scope, { note, end: measureStart + event.start + event.duration });
      }
      for (const [scope] of pendingTies) {
        if (!seen.has(scope)) { pendingTies.delete(scope); warn('tie', 'An incomplete tie was omitted.', location); }
      }
      project.outline.push({ id: id(), type: 'measure', data: { length, upperStaff, lowerStaff } });
      measureStart += measureDuration;
    });
    if (pendingTies.size) warn('tie', 'Ties without a continuation at the end of the score were omitted.');
    const pendingGlissandi = new Map<number, GlissandoMark>();
    const orphan = (mark: GlissandoMark) =>
      warn('glissando-endpoint', 'A glissando without two identifiable note endpoints was omitted.', mark.measure);
    for (const mark of glissandoMarks) {
      if ((mark.kind !== 'start' && mark.kind !== 'stop') || !Number.isInteger(mark.number) || mark.number < 1 || mark.number > 16) {
        orphan(mark);
        continue;
      }
      const previous = pendingGlissandi.get(mark.number);
      if (!previous) { pendingGlissandi.set(mark.number, mark); continue; }
      if (previous.kind === mark.kind) {
        orphan(previous);
        pendingGlissandi.set(mark.number, mark);
        continue;
      }
      // The same number can be reused after a pair in document order. The
      // first marker can be a stop when the document emits voices separately.
      pendingGlissandi.delete(mark.number);
      const [start, end] = mark.kind === 'start' ? [mark, previous] : [previous, mark];
      if (!start.endpoint || !end.endpoint || start.position === undefined || end.position === undefined ||
        end.position - start.position < EPSILON) {
        orphan(!end.endpoint ? end : start);
        continue;
      }
      (project.glissandi ??= []).push({ id: id(), start: start.endpoint, end: end.endpoint, lineType: start.lineType ?? end.lineType ?? 'wavy',
        ...(start.text || end.text ? { text: start.text || end.text } : {}) });
    }
    for (const mark of pendingGlissandi.values()) orphan(mark);
    const measureNumbers = new Map(project.outline.filter(block => block.type === 'measure')
      .map((measure, index) => [measure.id, index + 1]));
    for (const { first, playbackReason } of ScoreGlissando.ranges(project)) {
      if (playbackReason) warn('glissando-playback', `Glissando notation was retained. ${playbackReason}`, measureNumbers.get(first.measure.id));
    }
    if (!Validator.isValid(project)) throw new Error('The imported score could not be represented by the editor.');
    return { project, warnings };
  }
}
export default ImportMusicXml;
