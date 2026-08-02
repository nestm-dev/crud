import { HmacSha256CrudCursorCodec } from "./hmac-sha256-cursor-codec.ts";

const PUBLIC_TEST_SECRET = "@nestm/crud intentionally insecure public test cursor secret";

/**
 * Deterministic codec for tests only. Its key is public, so applications must
 * never expose this class from the primary package entry point.
 */
export class InsecureCrudCursorCodec extends HmacSha256CrudCursorCodec {
	constructor() {
		super(PUBLIC_TEST_SECRET);
	}
}
