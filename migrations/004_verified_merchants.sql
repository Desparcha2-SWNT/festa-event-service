-- Proyección de comercios verificados (ver contracts/events/user/merchant.verified.schema.json:
-- "event-service: habilita boletería para sus eventos"). El claim `role: merchant` del JWT solo
-- dice que la cuenta SE REGISTRÓ como comercio (auth-service lo deja elegir al usuario en el
-- registro, ver AuthService.register) — NO que un admin ya lo verificó. Crear un evento
-- ticketed exige además que el merchantId esté aquí Y que pertenezca al usuario autenticado
-- (user_id) — si no, cualquier merchant verificado podría crear eventos a nombre de otro.

CREATE TABLE verified_merchants (
  merchant_id    uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  business_name  text NOT NULL,
  verified_at    timestamptz NOT NULL
);

CREATE INDEX verified_merchants_user_id_idx ON verified_merchants (user_id);
