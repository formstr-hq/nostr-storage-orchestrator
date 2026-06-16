/*
  Warnings:

  - The `replicas` column on the `Blob` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Blob" DROP COLUMN "replicas",
ADD COLUMN     "replicas" TEXT[];
