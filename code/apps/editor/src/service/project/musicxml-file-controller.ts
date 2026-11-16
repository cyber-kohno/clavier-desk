import MusicXmlFile from '../../infra/tauri/musicxml-file.ts';
import ImportMusicXml, { type MusicXmlImportResult } from '../../infra/musicxml/import-musicxml.ts';

export type MusicXmlFileResult =
  | { type: 'success'; value: MusicXmlImportResult }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

namespace MusicXmlFileController {
  export async function load(): Promise<MusicXmlFileResult> {
    try {
      const path = await MusicXmlFile.openPath();
      if (path === null) return { type: 'cancelled' };
      return { type: 'success', value: ImportMusicXml.parse(await MusicXmlFile.read(path)) };
    } catch (error) {
      return { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}
export default MusicXmlFileController;
