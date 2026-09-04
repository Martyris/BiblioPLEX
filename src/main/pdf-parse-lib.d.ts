// pdf-parse's package entry (index.js) runs debug/self-test code at module load time whenever
// `module.parent` is falsy (`if (!module.parent) { ...reads a file from its own test/ folder... }`)
// — true for our bundled ESM main process, which crashed the app on startup importing it. Its
// internal implementation file has no such code, so deckExport.ts imports that directly instead;
// this just supplies the types @types/pdf-parse would have provided for the package root.
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(
    dataBuffer: Buffer,
    options?: {
      pagerender?: (pageData: unknown) => string | Promise<string>
      max?: number
      version?: string
    }
  ): Promise<{
    numpages: number
    numrender: number
    info: unknown
    metadata: unknown
    version: string
    text: string
  }>
  export default pdfParse
}
