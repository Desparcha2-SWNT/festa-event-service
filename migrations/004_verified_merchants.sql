-- Proyección de comercios verificados (ver contracts/events/user/merchant.verified.schema.json:
-- "event-service: habilita boletería para sus eventos"). El claim `role: merchant` del JWT solo
-- dice que la cuenta SE REGISTRÓ como comercio (auth-service lo deja elegir al usuario en el
-- registro, ver AuthService.register) — NO que un admin ya lo verificó. Crear un evento
-- ticketed exige además que el merchantId esté aquí.

CREATE TABLE verified_merchants (
  merchant_id    uuid PRIMARY KEY,
  business_name  text NOT NULL,
  verified_at    timestamptz NOT NULL
);
