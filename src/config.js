function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8083),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  amqpUrl: required('AMQP_URL'),
  jwtIssuer: required('JWT_ISSUER'),
  jwtPublicKeyPath: required('JWT_PUBLIC_KEY_PATH'),
};
