// Variables de entorno y una llave JWT desechable para que los módulos que las leen al
// importarse (config.js, middleware/auth.js) no truenen al cargar las pruebas.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'festa-event-service-test-'));
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPath = path.join(dir, 'jwt_public.pem');
writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/event_db_test';
process.env.AMQP_URL ??= 'amqp://test:test@localhost:5672';
process.env.JWT_ISSUER ??= 'festa-auth';
process.env.JWT_PUBLIC_KEY_PATH = publicKeyPath;
process.env.LOG_LEVEL ??= 'silent';
