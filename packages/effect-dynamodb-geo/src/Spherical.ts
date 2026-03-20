/**
 * Spherical — Pure spherical geometry functions.
 *
 * Provides:
 * - `initialBearingTo` — great-circle initial bearing (forward azimuth)
 * - `intersection` — intersection of two great-circle paths
 *
 * All angles are in degrees externally, radians internally.
 */

export interface LatLng {
  readonly latitude: number
  readonly longitude: number
}

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/**
 * Compute the initial bearing (forward azimuth) from `from` to `to`
 * along a great-circle path.
 *
 * Formula:
 *   θ = atan2(sin(Δλ)·cos(φ₂), cos(φ₁)·sin(φ₂) − sin(φ₁)·cos(φ₂)·cos(Δλ))
 *
 * Returns bearing in degrees [0, 360).
 */
export const initialBearing = (from: LatLng, to: LatLng): number => {
  const φ1 = toRad(from.latitude)
  const φ2 = toRad(to.latitude)
  const Δλ = toRad(to.longitude - from.longitude)

  const x = Math.sin(Δλ) * Math.cos(φ2)
  const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  const θ = Math.atan2(x, y)

  return (toDeg(θ) + 360) % 360
}

/**
 * Find the intersection point of two great-circle paths defined by
 * a start point and initial bearing each.
 *
 * Uses the Vincenty formula to compute the intersection.
 * Returns `undefined` when paths are parallel, antipodal, or ambiguous.
 */
export const intersection = (
  p1: LatLng,
  brng1: number,
  p2: LatLng,
  brng2: number,
): LatLng | undefined => {
  const φ1 = toRad(p1.latitude)
  const λ1 = toRad(p1.longitude)
  const φ2 = toRad(p2.latitude)
  const λ2 = toRad(p2.longitude)
  const θ13 = toRad(brng1)
  const θ23 = toRad(brng2)
  const Δφ = φ2 - φ1
  const Δλ = λ2 - λ1

  // Angular distance p1-p2
  const δ12 =
    2 *
    Math.asin(
      Math.sqrt(Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2),
    )

  if (Math.abs(δ12) < Number.EPSILON) return undefined

  // Initial/final bearings between p1-p2
  const cosθa = (Math.sin(φ2) - Math.sin(φ1) * Math.cos(δ12)) / (Math.sin(δ12) * Math.cos(φ1))
  const cosθb = (Math.sin(φ1) - Math.sin(φ2) * Math.cos(δ12)) / (Math.sin(δ12) * Math.cos(φ2))
  const θa = Math.acos(Math.min(1, Math.max(-1, cosθa)))
  const θb = Math.acos(Math.min(1, Math.max(-1, cosθb)))

  const θ12 = Math.sin(λ2 - λ1) > 0 ? θa : 2 * Math.PI - θa
  const θ21 = Math.sin(λ2 - λ1) > 0 ? 2 * Math.PI - θb : θb

  const α1 = θ13 - θ12
  const α2 = θ21 - θ23

  // Check for parallel/antipodal paths
  if (Math.sin(α1) === 0 && Math.sin(α2) === 0) return undefined
  if (Math.sin(α1) * Math.sin(α2) < 0) return undefined

  const cosα3 = -Math.cos(α1) * Math.cos(α2) + Math.sin(α1) * Math.sin(α2) * Math.cos(δ12)

  const δ13 = Math.atan2(
    Math.sin(δ12) * Math.sin(α1) * Math.sin(α2),
    Math.cos(α2) + Math.cos(α1) * cosα3,
  )

  const φ3 = Math.asin(
    Math.min(
      1,
      Math.max(-1, Math.sin(φ1) * Math.cos(δ13) + Math.cos(φ1) * Math.sin(δ13) * Math.cos(θ13)),
    ),
  )

  const Δλ13 = Math.atan2(
    Math.sin(θ13) * Math.sin(δ13) * Math.cos(φ1),
    Math.cos(δ13) - Math.sin(φ1) * Math.sin(φ3),
  )
  const λ3 = λ1 + Δλ13

  return {
    latitude: toDeg(φ3),
    longitude: ((toDeg(λ3) + 540) % 360) - 180,
  }
}

/**
 * Compute the great-circle distance between two points in meters.
 * Uses the Haversine formula.
 */
export const greatCircleDistance = (from: LatLng, to: LatLng): number => {
  const R = 6371008.8 // Earth mean radius in meters
  const φ1 = toRad(from.latitude)
  const φ2 = toRad(to.latitude)
  const Δφ = toRad(to.latitude - from.latitude)
  const Δλ = toRad(to.longitude - from.longitude)

  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}
