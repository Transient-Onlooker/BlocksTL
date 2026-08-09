import type { FitLevel } from './types'

/**
 * Physical connector dimensions stay fixed when the source model is scaled.
 * The 19/20/21 mapping is deliberately isolated so a printed coupon can
 * calibrate it without changing the spring-cell topology.
 */
export const CONNECTOR_PROFILE = {
  profileVersion: 'experimental-v1',
  calibrationSource: 'video estimate + print coupon',
  referenceLevel: 19 as FitLevel,
  referencePinDiameterMm: 5.8,
  diameterStepMm: 0.1,
  pinHeightMm: 5,
  pinLeadInMm: 0.9,
  pinEmbedMm: 0.65,
  pinRootReliefMm: 0.25,
  pinRootCollarHeightMm: 0.45,
  springGapMm: 5.65,
  springThicknessMm: 0.85,
  springDeflectionRoomMm: 0.6,
  springBeamWidthMm: 3.35,
  socketClearanceMm: 0.35,
  socketExtraDepthMm: 0.35,
  socketLeadInMm: 0.8,
  connectorPitchMm: 11.5,
  interCellWallMm: 0.8,
  edgeSafetyMm: 0.5,
  roofThicknessMm: 1.4,
} as const

export function pinDiameterFor(level: FitLevel) {
  return CONNECTOR_PROFILE.referencePinDiameterMm + (level - CONNECTOR_PROFILE.referenceLevel) * CONNECTOR_PROFILE.diameterStepMm
}

export function springCellSize() {
  return {
    width: CONNECTOR_PROFILE.springGapMm + CONNECTOR_PROFILE.springThicknessMm * 2 + CONNECTOR_PROFILE.springDeflectionRoomMm * 2,
    depth: CONNECTOR_PROFILE.referencePinDiameterMm + CONNECTOR_PROFILE.socketClearanceMm * 2,
  }
}
