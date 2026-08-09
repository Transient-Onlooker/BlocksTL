export function isBinaryStl(buffer: ArrayBuffer) {
  if (buffer.byteLength < 84) return false
  const triangleCount = new DataView(buffer).getUint32(80, true)
  const expectedBytes = 84 + triangleCount * 50
  // Some slicers append metadata after the declared triangle records.
  return triangleCount > 0 && expectedBytes <= buffer.byteLength
}

export function parseBinaryStl(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  const triangleCount = view.getUint32(80, true)
  const expectedBytes = 84 + triangleCount * 50
  if (!triangleCount || expectedBytes > buffer.byteLength) throw new Error('Binary STL의 triangle record가 잘렸거나 유효하지 않습니다.')
  const positions = new Float32Array(triangleCount * 9)
  let offset = 84
  let target = 0
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    offset += 12
    for (let vertex = 0; vertex < 3; vertex += 1) {
      positions[target++] = view.getFloat32(offset, true)
      positions[target++] = view.getFloat32(offset + 4, true)
      positions[target++] = view.getFloat32(offset + 8, true)
      offset += 12
    }
    offset += 2
  }
  return positions
}

export function parseAsciiStl(buffer: ArrayBuffer) {
  const values: number[] = []
  for (const match of new TextDecoder().decode(buffer).matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/gi)) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  if (!values.length || values.length % 9 || values.some((value) => !Number.isFinite(value))) throw new Error('유효한 ASCII 또는 Binary STL 파일을 읽을 수 없습니다.')
  return new Float32Array(values)
}

export function weldStlPositions(positions: Float32Array) {
  const vertexCount = positions.length / 3
  const vertices = new Float32Array(positions.length)
  const indices = new Uint32Array(vertexCount)
  const buckets = new Map<number, number | number[]>()
  let uniqueCount = 0
  const sameQuantizedPosition = (index: number, qx: number, qy: number, qz: number) => (
    Math.round(vertices[index * 3] * 1e6) === qx
    && Math.round(vertices[index * 3 + 1] * 1e6) === qy
    && Math.round(vertices[index * 3 + 2] * 1e6) === qz
  )
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('STL에 유효하지 않은 좌표가 포함되어 있습니다.')
    const qx = Math.round(x * 1e6)
    const qy = Math.round(y * 1e6)
    const qz = Math.round(z * 1e6)
    const hash = (Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) >>> 0
    const bucket = buckets.get(hash)
    let index: number | undefined
    if (typeof bucket === 'number') {
      if (sameQuantizedPosition(bucket, qx, qy, qz)) index = bucket
    } else if (bucket) {
      index = bucket.find((candidate) => sameQuantizedPosition(candidate, qx, qy, qz))
    }
    if (index === undefined) {
      index = uniqueCount
      vertices[index * 3] = x
      vertices[index * 3 + 1] = y
      vertices[index * 3 + 2] = z
      uniqueCount += 1
      if (bucket === undefined) buckets.set(hash, index)
      else if (typeof bucket === 'number') buckets.set(hash, [bucket, index])
      else bucket.push(index)
    }
    indices[i / 3] = index
  }
  return { vertices: vertices.slice(0, uniqueCount * 3), indices }
}
