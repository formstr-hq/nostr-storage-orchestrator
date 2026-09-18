-- Remove the strfry-backed relay data plane.
--
-- The public relay is now nostream backed by the mesh-PG gateway, so the
-- relay proxy and the strfry backend it published to are gone. Drop the
-- per-event accounting table and the storage column that advertised each
-- provider's strfry port.

-- DropTable
DROP TABLE "RelayEvent";

-- DropColumn
ALTER TABLE "Storage" DROP COLUMN "relayPort";
