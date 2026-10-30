// Prueba el despacho de handle() (sobre -> validar -> verificar productor -> validar data ->
// handler) con un canal y un registro de esquemas simulados, sin RabbitMQ ni Postgres reales.
import { describe, expect, it, vi } from 'vitest';
import { _internal } from '../../src/messaging/inboxConsumer.js';

function fakeChannel() {
  return { ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn() };
}

function fakeRegistry({ validEnvelope = true, dataValidator, expectedProducer } = {}) {
  const validateEnvelope = vi.fn().mockReturnValue(validEnvelope);
  validateEnvelope.errors = validEnvelope ? null : [{ message: 'sobre inválido' }];
  return {
    validateEnvelope,
    getExpectedProducer: vi.fn().mockReturnValue(expectedProducer),
    getDataValidator: vi.fn().mockReturnValue(dataValidator),
  };
}

function msgWith(envelope) {
  return { content: Buffer.from(JSON.stringify(envelope)), properties: { headers: {} } };
}

describe('handle (despacho del inbox)', () => {
  it('manda a la DLQ un mensaje que no es JSON', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry();
    const msg = { content: Buffer.from('esto no es json'), properties: { headers: {} } };

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ un sobre que no cumple envelope.schema.json', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ validEnvelope: false });
    const msg = msgWith({ eventType: 'merchant.verified' });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('manda a la DLQ si el productor declarado no es el dueño real del eventType', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ expectedProducer: 'user-service' });
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'payment-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si `data` no cumple su esquema', async () => {
    const channel = fakeChannel();
    const dataValidator = vi.fn().mockReturnValue(false);
    dataValidator.errors = [{ message: 'falta businessName' }];
    const registry = fakeRegistry({ expectedProducer: 'user-service', dataValidator });
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'user-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('confirma sin efecto un eventType válido sin handler todavía (p. ej. attendance.confirmed)', async () => {
    const channel = fakeChannel();
    const dataValidator = vi.fn().mockReturnValue(true);
    const registry = fakeRegistry({ expectedProducer: 'booking-service', dataValidator });
    const msg = msgWith({ eventId: '1', eventType: 'attendance.confirmed', producer: 'booking-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});
