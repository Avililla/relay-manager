-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EquipmentTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "spec" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "serialNumber" TEXT,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "templateId" TEXT,
    "templateName" TEXT,
    "reservedById" TEXT,
    "reservedAt" DATETIME,
    "reservationExpiresAt" DATETIME,
    "reservationNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Equipment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EquipmentTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Equipment_reservedById_fkey" FOREIGN KEY ("reservedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SerialConsole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "baudRate" INTEGER NOT NULL DEFAULT 115200,
    "dataBits" INTEGER NOT NULL DEFAULT 8,
    "parity" TEXT NOT NULL DEFAULT 'none',
    "stopBits" INTEGER NOT NULL DEFAULT 1,
    "flowControl" TEXT NOT NULL DEFAULT 'none',
    "enterMode" TEXT NOT NULL DEFAULT 'cr',
    "localEcho" BOOLEAN NOT NULL DEFAULT false,
    "hupcl" BOOLEAN NOT NULL DEFAULT false,
    "captureToDisk" BOOLEAN NOT NULL DEFAULT true,
    "identifyHostnameRegex" TEXT,
    "identifyBannerRegex" TEXT,
    "matchBy" TEXT,
    "bindingKey" TEXT,
    "byId" TEXT,
    "byPath" TEXT,
    "usbVendorId" TEXT,
    "usbProductId" TEXT,
    "usbSerial" TEXT,
    "usbInterface" INTEGER,
    "usbPortNumber" INTEGER,
    "usbIdPath" TEXT,
    "devicePath" TEXT,
    "adapterLabel" TEXT,
    "lastDevNode" TEXT,
    "lastSeenAt" DATETIME,
    "releasedAt" DATETIME,
    "releasedById" TEXT,
    "releasedByName" TEXT,
    "releaseUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SerialConsole_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RelayBoard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "httpPort" INTEGER NOT NULL DEFAULT 80,
    "tcpPort" INTEGER,
    "model" TEXT,
    "moduleId" INTEGER,
    "mac" TEXT,
    "relayCount" INTEGER NOT NULL,
    "options" JSONB,
    "username" TEXT,
    "password" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" DATETIME,
    "lastError" TEXT,
    "relayState" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RelayChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "channel" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT,
    "label" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'generic',
    "requireConfirm" BOOLEAN NOT NULL DEFAULT false,
    "defaultPulseMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RelayChannel_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RelayChannel_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "RelayBoard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" TEXT NOT NULL DEFAULT 'user',
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "ip" TEXT,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'ok',
    "equipmentId" TEXT,
    "equipmentName" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetName" TEXT,
    "detail" JSONB
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "labName" TEXT NOT NULL DEFAULT 'Relay Manager',
    "bannerText" TEXT,
    "reservationTimeoutMin" INTEGER NOT NULL DEFAULT 30,
    "reservationWarningMin" INTEGER NOT NULL DEFAULT 5,
    "captureRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "captureMaxTotalMb" INTEGER NOT NULL DEFAULT 2048,
    "captureMaxFileMb" INTEGER NOT NULL DEFAULT 64,
    "inputCapture" TEXT NOT NULL DEFAULT 'markers',
    "auditRetentionDays" INTEGER NOT NULL DEFAULT 365,
    "auditPurgeUnlocked" BOOLEAN NOT NULL DEFAULT false,
    "backupDailyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "backupDailyHour" INTEGER NOT NULL DEFAULT 3,
    "backupRetentionCount" INTEGER NOT NULL DEFAULT 14,
    "setupCompletedAt" DATETIME,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "_UserRoles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_UserRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_EquipmentRoles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_EquipmentRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_EquipmentRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTemplate_key_key" ON "EquipmentTemplate"("key");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTemplate_name_key" ON "EquipmentTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_name_key" ON "Equipment"("name");

-- CreateIndex
CREATE INDEX "Equipment_reservedById_idx" ON "Equipment"("reservedById");

-- CreateIndex
CREATE UNIQUE INDEX "SerialConsole_bindingKey_key" ON "SerialConsole"("bindingKey");

-- CreateIndex
CREATE UNIQUE INDEX "SerialConsole_equipmentId_position_key" ON "SerialConsole"("equipmentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SerialConsole_equipmentId_key_key" ON "SerialConsole"("equipmentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "RelayBoard_name_key" ON "RelayBoard"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RelayBoard_mac_key" ON "RelayBoard"("mac");

-- CreateIndex
CREATE UNIQUE INDEX "RelayBoard_host_httpPort_key" ON "RelayBoard"("host", "httpPort");

-- CreateIndex
CREATE UNIQUE INDEX "RelayChannel_boardId_channel_key" ON "RelayChannel"("boardId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "RelayChannel_equipmentId_position_key" ON "RelayChannel"("equipmentId", "position");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

-- CreateIndex
CREATE INDEX "AuditEvent_equipmentId_at_idx" ON "AuditEvent"("equipmentId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_at_idx" ON "AuditEvent"("actorId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_action_at_idx" ON "AuditEvent"("action", "at");

-- CreateIndex
CREATE UNIQUE INDEX "_UserRoles_AB_unique" ON "_UserRoles"("A", "B");

-- CreateIndex
CREATE INDEX "_UserRoles_B_index" ON "_UserRoles"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_EquipmentRoles_AB_unique" ON "_EquipmentRoles"("A", "B");

-- CreateIndex
CREATE INDEX "_EquipmentRoles_B_index" ON "_EquipmentRoles"("B");
