import Module from 'manifold-3d'

const wasm = await Module()
wasm.setup()

const profile = {
  pinHeight: 5,
  leadIn: 0.9,
  embed: 0.65,
  rootRelief: 0.25,
  rootCollarHeight: 0.45,
  springGap: 5.65,
  springThickness: 0.85,
  deflectionRoom: 0.6,
  beamWidth: 3.35,
  clearance: 0.35,
  extraDepth: 0.35,
  socketLeadIn: 0.8,
  roof: 1.4,
}

function addPin(block, diameter, z) {
  const radius = diameter / 2
  const root = wasm.Manifold.cylinder(profile.embed, radius + profile.rootRelief, radius + profile.rootRelief, 32).translate(0, 0, z - profile.embed)
  const collar = wasm.Manifold.cylinder(profile.rootCollarHeight, radius + profile.rootRelief, radius, 32).translate(0, 0, z)
  const shaft = wasm.Manifold.cylinder(profile.pinHeight - profile.leadIn - profile.rootCollarHeight, radius, radius, 32).translate(0, 0, z + profile.rootCollarHeight)
  const lead = wasm.Manifold.cylinder(profile.leadIn, radius, radius * 0.74, 32).translate(0, 0, z + profile.pinHeight - profile.leadIn)
  const rooted = root.add(collar)
  const body = rooted.add(shaft)
  const pin = body.add(lead)
  const result = block.add(pin)
  for (const item of [pin, lead, body, rooted, shaft, collar, root, block]) item.delete()
  return result
}

function addSocket(block, z) {
  const width = profile.springGap + profile.springThickness * 2 + profile.deflectionRoom * 2
  const depth = 5.8 + profile.clearance * 2
  const socketDepth = profile.pinHeight + profile.extraDepth
  const cavity = wasm.Manifold.cube([width, depth, socketDepth + 0.08], false).translate(-width / 2, -depth / 2, z - 0.04)
  const entrance = wasm.Manifold.cube([width + 0.5, depth + 0.5, profile.socketLeadIn + 0.04], false).translate(-(width + 0.5) / 2, -(depth + 0.5) / 2, z - 0.04)
  const socketVoid = cavity.add(entrance)
  let result = block.subtract(socketVoid)
  for (const item of [socketVoid, entrance, cavity, block]) item.delete()

  const beamStart = z + profile.socketLeadIn * 0.45
  const beamLength = socketDepth - profile.socketLeadIn * 0.45 + 0.25
  const left = wasm.Manifold.cube([profile.springThickness, profile.beamWidth, beamLength], false).translate(-profile.springGap / 2 - profile.springThickness, -profile.beamWidth / 2, beamStart)
  const right = wasm.Manifold.cube([profile.springThickness, profile.beamWidth, beamLength], false).translate(profile.springGap / 2, -profile.beamWidth / 2, beamStart)
  const springs = left.add(right)
  const combined = result.add(springs)
  for (const item of [springs, right, left, result]) item.delete()
  return combined
}

const results = []
for (const [level, diameter] of [[19, 5.8], [20, 5.9], [21, 6.0]]) {
  let male = wasm.Manifold.cube([14, 14, 3], true).translate(0, 0, 1.5)
  male = addPin(male, diameter, 3)
  let female = wasm.Manifold.cube([14, 14, profile.pinHeight + profile.extraDepth + profile.roof], true)
    .translate(0, 0, (profile.pinHeight + profile.extraDepth + profile.roof) / 2)
  female = addSocket(female, 0)
  const printableFemale = female.rotate(180, 0, 0).translate(0, 0, profile.pinHeight + profile.extraDepth + profile.roof)
  female.delete()
  female = printableFemale
  if (male.status() !== 'NoError' || female.status() !== 'NoError') throw new Error(`Fit ${level} produced an invalid manifold`)
  if (!male.getMesh().triVerts.length || !female.getMesh().triVerts.length) throw new Error(`Fit ${level} produced an empty mesh`)
  results.push({
    level,
    diameter,
    totalInterference: +(diameter - profile.springGap).toFixed(2),
    perBeamDeflection: +((diameter - profile.springGap) / 2).toFixed(3),
    maleTriangles: male.getMesh().triVerts.length / 3,
    femaleTriangles: female.getMesh().triVerts.length / 3,
    maleVolume: +male.volume().toFixed(2),
    femaleVolume: +female.volume().toFixed(2),
  })
  male.delete()
  female.delete()
}

console.log(JSON.stringify({ status: 'NoError', springGap: profile.springGap, results }))
