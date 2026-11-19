import assert from 'node:assert/strict';
import { test } from 'node:test';
import Authoring from '../src/action/editor/score-authoring.ts';
import EditTransaction from '../src/action/editor/edit-transaction.ts';
import ScorePlaybackPlan from '../src/domain/performance/score-playback-plan.ts';
import ScoreDynamics from '../src/domain/score/score-dynamics.ts';
import ScoreHairpins from '../src/domain/score/score-hairpins.ts';
import ScoreProjectValidator from '../src/domain/score/score-project-validator.ts';
import Factory from '../src/domain/score/score-project.ts';
import ScoreTimeline from '../src/domain/score/score-timeline.ts';
import Preview from '../src/infra/musicxml/preview-musicxml.ts';

function fixture() {
  const quarters = (...pitches) => pitches.map(pitch => ({ value: '4', pitches: [pitch] }));
  return Authoring.apply(Factory.create(), Authoring.createState(), [{ type: 'create_score',
    settings: { meter: [4, 4], keyFifths: 0, tempo: 120 }, measures: [
      { upper: [quarters('C4', 'D4', 'E4', 'F4'), quarters('G4', 'A4', 'B4', 'C5')],
        lower: [quarters('C3', 'D3', 'E3', 'F3')] }, {}, {}, {}, {},
    ] }]).project;
}

test('notation-only hairpins preserve current dynamics and configured velocities affect all simultaneous attacks', () => {
  const project = ScoreHairpins.add(fixture(), 2, 10);
  const [{ id }] = project.hairpins;
  const positionSamples = [0, 2, 4, 6, 8, 10, 12];
  const sample = score => positionSamples.map(ScoreDynamics.createVelocityLookup(score));
  assert.deepEqual(sample(project), [88, 88, 88, 88, 88, 88, 88]);

  const configured = ScoreHairpins.configure(project, id, 'decrescendo', { start: 60, end: 100 });
  assert.deepEqual(sample(configured), [88, 60, 70, 80, 90, 100, 100]);
  const events = new Map(ScorePlaybackPlan.create(configured, 0).events.map(event => [event.pitches[0], event.velocity]));
  assert.deepEqual([events.get(62), events.get(69), events.get(50)], [70, 70, 70]);
  assert.deepEqual([events.get(65), events.get(72), events.get(53)], [100, 100, 100]);
  assert.deepEqual(sample(ScoreHairpins.remove(configured, 6)), sample(project));
});

test('interior dynamics split interpolation and an immediate dynamic at the end takes precedence', () => {
  const project = ScoreHairpins.add(fixture(), 0, 8);
  const [first, middle, end] = ScoreTimeline.notes(project.outline, 'upperStaff', 0);
  let configured = ScoreHairpins.configure(project, project.hairpins[0].id, 'crescendo', { start: 60, end: 100 });
  configured = ScoreDynamics.set(configured, first.note.id, 'p', 71);
  configured = ScoreDynamics.set(configured, middle.note.id, 'mp', 80);
  configured = ScoreDynamics.set(configured, end.note.id, 'mf', 85);
  assert.deepEqual([0, 2, 4, 6, 8, 12].map(ScoreDynamics.createVelocityLookup(configured)), [60, 70, 80, 90, 85, 85]);
  assert.deepEqual(ScoreDynamics.hairpinSegments(configured).map(({ start, end }) => [start.position, end.position]), [[0, 4], [4, 8]]);
});

test('hairpins persist across empty measures and preview boundaries, and reconcile deleted endpoints', () => {
  const project = ScoreHairpins.add(fixture(), 5, 66);
  const { id, start, end } = project.hairpins[0];
  assert.equal(ScoreHairpins.add(project, 6, 14), project);
  const adjacent = ScoreHairpins.add(project, 66, 80);
  assert.equal(ScoreHairpins.at(adjacent, 66).hairpin.id, adjacent.hairpins[1].id);
  assert.equal(ScoreHairpins.at(adjacent, 65).hairpin.id, id);
  const restored = JSON.parse(JSON.stringify(project));
  assert.ok(ScoreProjectValidator.isValid(restored));
  const invalid = { ...restored, hairpins: [{ ...restored.hairpins[0], end: { ...end, measureId: 'missing-measure' } }] };
  assert.equal(ScoreProjectValidator.isValid(invalid), false);
  const clipped = Preview.create(restored.outline, 2, [], [], [], [], [], undefined, restored.hairpins).hairpins;
  assert.deepEqual(clipped, [{ start: { measureOffset: 0, position: 0, opening: 11 / 61 },
    end: { measureOffset: 2, position: 16, opening: 59 / 61 } }]);
  const deleted = { ...restored, outline: restored.outline.filter(block => block.id !== start.measureId) };
  assert.deepEqual(EditTransaction.commit(restored, deleted).hairpins, []);
});
