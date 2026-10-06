-- AlterTable (plain ADD COLUMN: no table redefinition; existing users get NULL = no theme chosen yet)
ALTER TABLE "User" ADD COLUMN "theme" TEXT;
