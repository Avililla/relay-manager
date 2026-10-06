-- CreateTable
CREATE TABLE "EquipmentNetwork" (
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
    "equipmentIp" TEXT NOT NULL DEFAULT '192.168.1.10',
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

-- AlterTable (plain ADD COLUMN: no table redefinition, the rows and indexes stay as they are)
ALTER TABLE "EquipmentAccess" ADD COLUMN "targetMode" TEXT NOT NULL DEFAULT 'ip';
ALTER TABLE "EquipmentAccess" ADD COLUMN "switchPort" INTEGER;
ALTER TABLE "EquipmentAccess" ADD COLUMN "sshUser" TEXT;
