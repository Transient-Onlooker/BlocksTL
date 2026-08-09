import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Node 22 cannot import TypeScript source directly. Compile this small,
// dependency-free utility in memory so the regression test exercises the same
// module used by the browser without relying on experimental Node flags.
const stlSourceUrl = new URL('../src/stl.ts', import.meta.url)
const stlSource = await readFile(stlSourceUrl, 'utf8')
const transpiled = ts.transpileModule(stlSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: stlSourceUrl.pathname,
  reportDiagnostics: true,
})
const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
if (errors.length) {
  throw new Error(ts.formatDiagnostics(errors, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
}

const stlModuleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
const { isBinaryStl, parseAsciiStl, parseBinaryStl, weldStlPositions } = await import(stlModuleUrl)

function oneTriangleBinary(trailingBytes = 0) {
  const buffer = new ArrayBuffer(84 + 50 + trailingBytes)
  const header = new TextEncoder().encode('solid-looking binary STL')
  new Uint8Array(buffer).set(header.subarray(0, 80))
  const view = new DataView(buffer)
  view.setUint32(80, 1, true)
  let offset = 96
  for (const value of [0, 0, 0, 1, 0, 0, 0, 1, 0]) {
    view.setFloat32(offset, value, true)
    offset += 4
  }
  return buffer
}

const exactBinary = oneTriangleBinary()
const trailingBinary = oneTriangleBinary(23)
if (!isBinaryStl(exactBinary) || !isBinaryStl(trailingBinary)) throw new Error('Binary STL with valid records was not detected')
const binaryPositions = parseBinaryStl(trailingBinary)
if (binaryPositions.length !== 9 || binaryPositions[3] !== 1 || binaryPositions[7] !== 1) throw new Error('Binary STL vertices were parsed incorrectly')

const truncated = oneTriangleBinary()
new DataView(truncated).setUint32(80, 2, true)
if (isBinaryStl(truncated)) throw new Error('Truncated Binary STL should fail plausibility detection')

const ascii = new TextEncoder().encode(`solid sample
facet normal 0 0 1
 outer loop
  VERTEX 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid sample`).buffer
if (isBinaryStl(ascii)) throw new Error('ASCII STL was misclassified as binary')
if (parseAsciiStl(ascii).length !== 9) throw new Error('ASCII STL vertices were parsed incorrectly')

const welded = weldStlPositions(new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  0, 0, 0, 0, 1, 0, 0, 0, 1,
]))
if (welded.vertices.length !== 12) throw new Error('Numeric vertex welding did not remove duplicate STL vertices')
if (welded.indices.join(',') !== '0,1,2,0,2,3') throw new Error('Numeric vertex welding changed triangle topology')

console.log(JSON.stringify({ status: 'NoError', exactBinary: true, trailingBinary: true, truncatedRejected: true, asciiCaseInsensitive: true, numericWelding: true }))
