// Global test environment defaults so services that read validated env can be
// unit-tested without a real configuration.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.OWNER_WHATSAPP_NUMBER ||= '972500000000';
process.env.OWNER_TIMEZONE ||= 'Asia/Jerusalem';
process.env.OWNER_LANGUAGE ||= 'he';
process.env.WHATSAPP_VERIFY_TOKEN ||= 'verify';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'test_token';
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'test_phone_id';
process.env.META_APP_SECRET ||= 'test_secret';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ||= 'test_key_at_least_16_chars_long';
