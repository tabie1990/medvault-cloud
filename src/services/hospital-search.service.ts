import { prisma } from '../db/prisma.js';

/**
 * Plain Haversine distance in raw SQL — no PostGIS extension needed for
 * a search radius this small (a handful of hospitals per city, not a
 * global-scale geo index). Shared between the public HTTP endpoint and
 * the WhatsApp agent's tool, so the two never drift apart the way two
 * independently-written copies of the same query eventually would.
 */
export async function findHospitalsNear(lat: number, lng: number, radiusKm: number): Promise<any[]> {
  return prisma.$queryRawUnsafe(
    `SELECT *, (
      6371 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos(radians($1)) * cos(radians("latitude")) * cos(radians("longitude") - radians($2)) +
          sin(radians($1)) * sin(radians("latitude"))
        ))
      )
    ) AS distance_km
    FROM "Hospital"
    WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL AND status = 'active'
    HAVING (
      6371 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos(radians($1)) * cos(radians("latitude")) * cos(radians("longitude") - radians($2)) +
          sin(radians($1)) * sin(radians("latitude"))
        ))
      )
    ) <= $3
    ORDER BY distance_km ASC
    LIMIT 20`,
    lat,
    lng,
    radiusKm
  ) as Promise<any[]>;
}
