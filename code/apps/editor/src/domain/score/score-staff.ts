import type { ScoreProject, PianoStaffName } from './types.ts';
import RestSpelling from './rest-spelling.ts';
import ScoreTies from './score-ties.ts';
namespace ScoreStaff {
  export function clearVoice(project: ScoreProject, measureId: string, staff: PianoStaffName, voiceIndex: number): ScoreProject {
    return editVoice(project, measureId, staff, voiceIndex, false);
  }
  export function removeVoice(project: ScoreProject, measureId: string, staff: PianoStaffName, voiceIndex: number): ScoreProject {
    return editVoice(project, measureId, staff, voiceIndex, true);
  }
  function editVoice(project: ScoreProject, measureId: string, staff: PianoStaffName, voiceIndex: number, remove: boolean): ScoreProject {
    const measure = project.outline.find(block => block.id === measureId);
    if (measure?.type !== 'measure') return project;
    const voices = measure.data[staff].voices;
    const voice = voices[voiceIndex];
    if (!voice || (remove && voices.length === 1)) return project;
    if (!remove && voice.elements.length === 1 && voice.elements[0].kind === 'measure-rest') return project;
    const nextVoices = remove
      ? voices.filter((_, index) => index !== voiceIndex).map((entry, index) => ({ ...entry, id: `voice-${index}` }))
      : voices.map((entry, index) => index !== voiceIndex ? entry : { ...entry,
          elements: [{ id: RestSpelling.createId(), kind: 'measure-rest' as const }] });
    const outline = project.outline.map(block => block !== measure ? block : { ...measure, data: {
      ...measure.data, [staff]: { ...measure.data[staff], voices: nextVoices },
    } }) as ScoreProject['outline'];
    return { ...project, outline: ScoreTies.reconcile(outline) };
  }
  export function addVoice(project: ScoreProject, measureId: string, staff: PianoStaffName, voiceIndex: number): ScoreProject {
    const measure = project.outline.find(block => block.type === 'measure' && block.id === measureId);
    if (!measure || measure.type !== 'measure') return project;
    const nextIndex = voiceIndex + 1;
    if (nextIndex >= 3 || measure.data[staff].voices.length !== nextIndex) return project;
    return {
      ...project, outline: project.outline.map((block) => block !== measure ? block : {
        ...block, data: {
          ...block.data, [staff]: {
            ...block.data[staff], voices: [...block.data[staff].voices, {
              id: `voice-${nextIndex}`, elements: [{ id: RestSpelling.createId(), kind: 'measure-rest' }],
            }],
          }
        },
      }) as ScoreProject['outline']
    };
  }


}
export default ScoreStaff;
