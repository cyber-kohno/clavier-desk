import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import Import from '../src/infra/musicxml/import-musicxml.ts';
import Validator from '../src/domain/score/score-project-validator.ts';
import Authoring from '../src/action/editor/score-authoring.ts';
import Voice from '../src/domain/score/score-voice.ts';

globalThis.DOMParser = DOMParser;
const attributes = '<attributes><divisions>12</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>';
const note = (step = 'C', octave = 4, duration = 12, extra = '', type = 'quarter', staff = 1, voice = 1) =>
  `<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${type}</type><staff>${staff}</staff></note>`;
const score = (content, extraParts = '') => `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${content}</part>${extraParts}</score-partwise>`;
const measure = (content, attr = '') => `<measure number="1" ${attr}>${content}</measure>`;
const load = xml => {
  const result = Import.parse(xml);
  assert.ok(Validator.isValid(result.project));
  Authoring.validate(result.project, Authoring.createState(), true);
  return result;
};
const measures = result => result.project.outline.filter(block => block.type === 'measure');
const elements = (result, staff = 'upperStaff', voice = 0, index = 0) => measures(result)[index].data[staff].voices[voice].elements;
const has = (result, code) => result.warnings.some(warning => warning.code === code);

test('imports a grand staff, chords, backup/forward and persistent voice identities', () => {
  const result = load(score(measure(attributes + note() + note('E', 4, 12, '<chord/>') +
    '<forward><duration>12</duration></forward>' + note('G') +
    '<backup><duration>36</duration></backup>' + note('C', 3, 48, '', 'whole', 2, 5) +
    '<backup><duration>48</duration></backup>' + note('D', 4, 48, '', 'whole', 1, 2))));
  assert.deepEqual(elements(result)[0].pitches.map(p => p.midi), [64, 60]);
  const entries = Voice.locate(measures(result)[0].data.upperStaff.voices[0], { cnt: 4, unit: 4 });
  assert.equal(entries.find(entry => entry.element.kind === 'note' && entry.element.pitches[0].midi === 67).positionSixteenths, 8);
  assert.equal(elements(result, 'lowerStaff')[0].pitches[0].midi, 48);
  assert.equal(measures(result)[0].data.upperStaff.voices.length, 2);
  assert.deepEqual(result.warnings, []);
});

test('drops out-of-range chord tones and replaces excluded single notes with timed rests', () => {
  const result = load(score(measure(attributes + note('C', 9) + note('A', 0) + note('C', 9, 12, '<chord/>') + note('C', 8))));
  assert.equal(elements(result)[0].kind, 'rest');
  assert.equal(elements(result)[1].pitches[0].midi, 21);
  assert.equal(elements(result)[2].pitches[0].midi, 108);
  assert.ok(has(result, 'range'));
});

test('warns on a single staff and pads the lower staff with a measure rest', () => {
  const result = load(score(measure(note())));
  assert.ok(has(result, 'grand-staff'));
  assert.equal(elements(result, 'lowerStaff')[0].kind, 'measure-rest');
});

test('selects a two-staff part ahead of another instrument', () => {
  const xml = score(measure(note('D')), `<part id="P2">${measure(attributes + note('F'))}</part>`);
  const result = load(xml);
  assert.equal(elements(result)[0].pitches[0].midi, 65);
  assert.ok(has(result, 'parts'));
});

test('imports an implicit pickup without padding it to a full bar', () => {
  const result = load(score(measure(attributes + note(), 'implicit="yes"') + measure(note('D', 4, 48, '', 'whole'))));
  assert.deepEqual(measures(result)[0].data.length, { cnt: 1, unit: 4 });
  assert.equal(elements(result).length, 1);
});

test('retains the next note onset after a complete triplet', () => {
  const triplet = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  const result = load(score(measure(attributes + [0, 1, 2].map(() => note('C', 4, 4, triplet, 'eighth')).join('') + note('D'))));
  assert.equal(elements(result)[0].kind, 'tuplet');
  assert.equal(Voice.locate(measures(result)[0].data.upperStaff.voices[0], { cnt: 4, unit: 4 })[1].positionSixteenths, 4);
  assert.ok(!has(result, 'voice-fallback'));
});

test('imports mixed-value tuplets, including chords and back-to-back groups, and validates saved data', () => {
  const modification = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes><normal-type>eighth</normal-type></time-modification>';
  const mark = type => `<notations><tuplet type="${type}"/></notations>`;
  const excerpt = note('F', 4, 4, modification + mark('start'), 'eighth') +
    note('D', 5, 4, '<chord/>' + modification, 'eighth') +
    note('A', 4, 8, modification + mark('stop'), 'quarter') +
    note('F', 4, 8, modification, 'quarter') +
    note('G', 4, 4, modification, 'eighth') + note('C');
  const result = load(score(measure(attributes + excerpt)));
  const [first, second, next] = elements(result);
  assert.equal(first.kind, 'tuplet');
  assert.equal(second.kind, 'tuplet');
  assert.equal(first.baseType, 'eighth');
  assert.deepEqual(first.elements.map(element => [element.value.type, element.pitches.map(p => p.midi)]),
    [['eighth', [74, 65]], ['quarter', [69]]]);
  assert.deepEqual(second.elements.map(element => element.value.type), ['quarter', 'eighth']);
  assert.equal(next.kind, 'note');
  const entries = Voice.flatten(measures(result)[0].data.upperStaff.voices[0], { cnt: 4, unit: 4 });
  assert.equal(entries[4].positionSixteenths, 8);
  assert.ok(!has(result, 'voice-fallback'));
  const saved = JSON.parse(JSON.stringify(result.project));
  assert.ok(Validator.isValid(saved));
  saved.outline.find(block => block.type === 'measure').data.upperStaff.voices[0].elements[0].elements.pop();
  assert.equal(Validator.isValid(saved), false);
});

test('isolates unsupported rhythms to the affected voice and measure', () => {
  const result = load(score(measure(attributes + note('C', 4, 1, '', '64th') +
    '<backup><duration>1</duration></backup>' + note('D', 4, 48, '', 'whole', 1, 2) +
    '<backup><duration>48</duration></backup>' + note('C', 3, 48, '', 'whole', 2)) + measure(note('E', 4, 48, '', 'whole'))));
  assert.equal(elements(result)[0].kind, 'measure-rest');
  assert.equal(elements(result, 'upperStaff', 1)[0].kind, 'note');
  assert.equal(elements(result, 'lowerStaff')[0].kind, 'note');
  assert.equal(elements(result, 'upperStaff', 0, 1)[0].kind, 'note');
  assert.ok(has(result, 'voice-fallback'));
});

test('retains only three voices and reports the omitted voice', () => {
  const result = load(score(measure(attributes + [1, 2, 3, 4].map((voice, i) =>
    (i ? '<backup><duration>48</duration></backup>' : '') + note('C', 4, 48, '', 'whole', 1, voice)).join(''))));
  assert.equal(measures(result)[0].data.upperStaff.voices.length, 3);
  assert.ok(has(result, 'voices'));
});

test('restores complete-chord ties across measures', () => {
  const result = load(score(measure(attributes + note('C', 4, 48, '<tie type="start"/>', 'whole')) +
    measure(note('C', 4, 48, '<tie type="stop"/>', 'whole'))));
  assert.equal(elements(result)[0].tieTo, elements(result, 'upperStaff', 0, 1)[0].id);
  assert.ok(!has(result, 'tie'));
});

test('never joins ties over rests or omitted pitches', () => {
  const result = load(score(measure(attributes + note('C', 4, 12, '<tie type="start"/>') +
    note('C', 9) + note('C', 4, 12, '<tie type="stop"/>'))));
  assert.equal(elements(result)[0].tieTo, undefined);
  assert.equal(elements(result)[2].tieFrom, undefined);
  assert.ok(has(result, 'tie'));
});

test('never joins a tie over a rest at the end of the previous measure', () => {
  const result = load(score(measure(attributes + note('C', 4, 12, '<tie type="start"/>')) +
    measure(note('C', 4, 48, '<tie type="stop"/>', 'whole'))));
  assert.equal(elements(result)[0].tieTo, undefined);
  assert.ok(has(result, 'tie'));
});

test('imports initial tempo, key changes, and measure lengths while reporting time-signature changes', () => {
  const result = load(score(measure(attributes + '<direction><sound tempo="120"/></direction>' + note('C', 4, 48, '', 'whole')) +
    measure('<attributes><key><fifths>-2</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>' + note())));
  assert.equal(result.project.outline[0].data.tempo, 120);
  assert.equal(result.project.outline.find(block => block.type === 'key-change').data.keySignature.fifths, -2);
  assert.deepEqual(measures(result)[1].data.length, { cnt: 3, unit: 4 });
  assert.ok(has(result, 'meter'));
});

test('accepts a type-less full-measure rest', () => {
  const result = load(score(measure(attributes + '<note><rest measure="yes"/><duration>48</duration><staff>1</staff></note>')));
  assert.equal(elements(result)[0].kind, 'measure-rest');
});

test('reports dropped grace notes, directions, repeats and notation', () => {
  const result = load(score(measure(attributes + '<note><grace/><pitch><step>D</step><octave>4</octave></pitch><type>eighth</type></note>' +
    '<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>' +
    note('C', 4, 12, '<notations><slur type="start"/></notations>') + '<barline><repeat direction="backward"/></barline>')));
  for (const code of ['grace', 'direction', 'notation', 'repeat']) assert.ok(has(result, code), code);
});

test('rejects unsupported roots, empty scores, malformed XML and internal entities', () => {
  for (const xml of ['<score-timewise/>', '<score-partwise/>', score(''), '<score-partwise><part></score-partwise>',
    '<!DOCTYPE score-partwise [<!ENTITY foo "test">]><score-partwise/>']) assert.throws(() => Import.parse(xml));
});

test('accepts standard external MusicXML DOCTYPE without resolving it', () => {
  const result = load('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' + score(measure(attributes + note())));
  assert.equal(elements(result)[0].kind, 'note');
});

test('handles namespaced MusicXML and changing divisions', () => {
  const result = load(score(measure(attributes + note()) +
    measure('<attributes><divisions>24</divisions></attributes>' + note('D', 4, 24))).replace('<score-partwise ', '<score-partwise xmlns="http://www.musicxml.org/ns/musicxml" '));
  assert.deepEqual(elements(result)[0].value, elements(result, 'upperStaff', 0, 1)[0].value);
});

test('a malformed backup does not break subsequent measures', () => {
  const result = load(score(measure(attributes + '<backup><duration>12</duration></backup>' + note()) + measure(note('D'))));
  assert.equal(elements(result)[0].kind, 'measure-rest');
  assert.equal(elements(result, 'upperStaff', 0, 1)[0].kind, 'note');
});
