import { isBinaryStl, parseAsciiStl, parseBinaryStl, weldStlPositions } from '../src/stl.ts'

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
const inchScaled = weldStlPositions(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 25.4)
if (Math.abs(inchScaled.vertices[3] - 25.4) > 1e-5) throw new Error('Welding did not apply source-unit scale')

const withDegenerates = weldStlPositions(new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 1, 0, 0,
  10_000, 10_000, 10_000, 10_001, 10_000, 10_000, 10_002, 10_000, 10_000,
]))
if (withDegenerates.indices.length !== 3 || withDegenerates.removedTriangles !== 2) throw new Error('Degenerate triangles were not removed')
if (Math.max(...Array.from(withDegenerates.indices, (index) => withDegenerates.vertices[index * 3])) > 1) throw new Error('Removed degenerate outliers still affect indexed geometry')

for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
  const values = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, invalid])
  let rejected = false
  try { weldStlPositions(values) } catch { rejected = true }
  if (!rejected) throw new Error(`${invalid} vertex was not rejected`)
}

let allDegenerateRejected = false
try { weldStlPositions(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])) } catch { allDegenerateRejected = true }
if (!allDegenerateRejected) throw new Error('All-degenerate STL should fail clearly')

console.log(JSON.stringify({ status: 'NoError', exactBinary: true, trailingBinary: true, truncatedRejected: true, asciiCaseInsensitive: true, numericWelding: true, unitScaling: true, degenerateFiltering: true, nonFiniteRejected: true }))
