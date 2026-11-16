import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';

namespace MusicXmlFile {
  export async function openPath(): Promise<string | null> {
    const path = await open({ multiple: false, directory: false,
      filters: [{ name: 'MusicXML (uncompressed)', extensions: ['musicxml', 'xml'] }] });
    return typeof path === 'string' ? path : null;
  }

  export async function read(path: string): Promise<string> {
    return readTextFile(path);
  }
}
export default MusicXmlFile;
