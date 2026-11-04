/** The PNG codec the screen-reading tests decode screenshots with (pngjs ships no types). */
declare module 'pngjs' {
  export const PNG: {
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer };
    };
  };
}
