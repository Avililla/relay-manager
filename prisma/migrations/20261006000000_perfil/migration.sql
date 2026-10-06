-- 3.0.0: templates come from the profile's files (source/sourceFile/retiredAt; the old predefined flag goes away:
-- those rows stay as local, editable templates with their key, and the first sync links them to a file with that
-- key, if any). The equipment IP of the equipment network has no default any more (existing values are kept).
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EquipmentNetwork" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoDetect" BOOLEAN NOT NULL DEFAULT true,
    "adapterMac" TEXT,
    "driver" TEXT NOT NULL DEFAULT 'tplink-easy-smart',
    "switchHost" TEXT,
    "switchUsername" TEXT,
    "switchPassword" TEXT,
    "switchModel" TEXT,
    "switchFirmware" TEXT,
    "switchMac" TEXT,
    "portCount" INTEGER NOT NULL DEFAULT 8,
    "uplinkPort" INTEGER NOT NULL DEFAULT 1,
    "vlanBase" INTEGER NOT NULL DEFAULT 100,
    "mgmtAddress" TEXT NOT NULL DEFAULT '192.168.0.250/24',
    "equipmentIp" TEXT,
    "equipmentPrefix" INTEGER NOT NULL DEFAULT 24,
    "hostOffset" INTEGER NOT NULL DEFAULT 200,
    "appliedAt" DATETIME,
    "appliedLayout" JSONB,
    "previousConfig" JSONB,
    "previousAt" DATETIME,
    "backupFile" TEXT,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_EquipmentNetwork" ("adapterMac", "appliedAt", "appliedLayout", "autoDetect", "backupFile", "driver", "enabled", "equipmentIp", "equipmentPrefix", "hostOffset", "id", "mgmtAddress", "portCount", "previousAt", "previousConfig", "switchFirmware", "switchHost", "switchMac", "switchModel", "switchPassword", "switchUsername", "updatedAt", "updatedById", "uplinkPort", "vlanBase") SELECT "adapterMac", "appliedAt", "appliedLayout", "autoDetect", "backupFile", "driver", "enabled", "equipmentIp", "equipmentPrefix", "hostOffset", "id", "mgmtAddress", "portCount", "previousAt", "previousConfig", "switchFirmware", "switchHost", "switchMac", "switchModel", "switchPassword", "switchUsername", "updatedAt", "updatedById", "uplinkPort", "vlanBase" FROM "EquipmentNetwork";
DROP TABLE "EquipmentNetwork";
ALTER TABLE "new_EquipmentNetwork" RENAME TO "EquipmentNetwork";
CREATE TABLE "new_EquipmentTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'local',
    "sourceFile" TEXT,
    "retiredAt" DATETIME,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "spec" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_EquipmentTemplate" ("createdAt", "description", "id", "key", "name", "needsReview", "position", "spec", "updatedAt") SELECT "createdAt", "description", "id", "key", "name", "needsReview", "position", "spec", "updatedAt" FROM "EquipmentTemplate";
DROP TABLE "EquipmentTemplate";
ALTER TABLE "new_EquipmentTemplate" RENAME TO "EquipmentTemplate";
CREATE UNIQUE INDEX "EquipmentTemplate_key_key" ON "EquipmentTemplate"("key");
CREATE UNIQUE INDEX "EquipmentTemplate_name_key" ON "EquipmentTemplate"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

