-- "Archivos › Enviar a equipo": remembered SSH login and host key fingerprint per equipment. Only a new table: no
-- existing table is redefined, so no cascade risk.
-- CreateTable
CREATE TABLE "EquipmentSshProfile" (
    "equipmentId" TEXT NOT NULL PRIMARY KEY,
    "remembered" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "password" TEXT,
    "destPath" TEXT,
    "hostKeyType" TEXT,
    "hostKeyFingerprint" TEXT,
    "hostKeySeenAt" DATETIME,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EquipmentSshProfile_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

