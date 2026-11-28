-- Revocación de la verificación de un comercio (auditoría de seguridad, 2026-11-28).
-- user-service publica merchant.updated con verified=false cuando un admin rechaza a un comercio que
-- estaba verificado, o cuando el comercio cambia datos críticos y vuelve a revisión. Antes ese mensaje
-- solo cambiaba el nombre y el comercio seguía habilitado aquí para crear eventos como comercio.
-- revoked_at guarda la hora de esa revocación: un merchant.verified más viejo que llegue después no
-- lo vuelve a habilitar (isMerchantOwnedAndVerified exige verified_at > revoked_at).
ALTER TABLE verified_merchants ADD COLUMN revoked_at timestamptz;

-- Para que un usuario no publique a nombre de un comercio verificado (organizerName).
CREATE INDEX verified_merchants_business_name_idx ON verified_merchants (lower(business_name));
