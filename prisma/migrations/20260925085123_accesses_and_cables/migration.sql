-- CreateTable
CREATE TABLE "EquipmentAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "policy" TEXT NOT NULL DEFAULT 'reserved',
    "jtagCableSerial" TEXT,
    "consoleId" TEXT,
    "targetHost" TEXT,
    "targetPort" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EquipmentAccess_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EquipmentAccess_consoleId_fkey" FOREIGN KEY ("consoleId") REFERENCES "SerialConsole" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CableLabel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "vendorId" TEXT,
    "productId" TEXT,
    "product" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentAccess_port_key" ON "EquipmentAccess"("port");

-- CreateIndex
CREATE INDEX "EquipmentAccess_consoleId_idx" ON "EquipmentAccess"("consoleId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentAccess_equipmentId_key_key" ON "EquipmentAccess"("equipmentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CableLabel_kind_identity_key" ON "CableLabel"("kind", "identity");

-- CreateIndex
CREATE UNIQUE INDEX "CableLabel_kind_name_key" ON "CableLabel"("kind", "name");
