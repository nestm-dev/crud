export type MemoryCrudClone<RecordType> = (record: RecordType) => RecordType;

export interface MemoryCrudStoreOptions<RecordType> {
	readonly initialRecords?: readonly RecordType[];
	readonly clone?: MemoryCrudClone<RecordType>;
}

function defaultClone<RecordType>(record: RecordType): RecordType {
	return structuredClone(record);
}

/**
 * Consumer-visible storage for the memory adapter.
 *
 * Every value crossing the store boundary is cloned. This prevents controller
 * response mapping or test fixtures from mutating committed records by
 * retaining an object reference.
 */
export class MemoryCrudStore<RecordType> {
	readonly #clone: MemoryCrudClone<RecordType>;
	#records: readonly RecordType[];

	constructor(options: MemoryCrudStoreOptions<RecordType> = {}) {
		this.#clone = options.clone ?? defaultClone;
		this.#records = this.#cloneRecords(options.initialRecords ?? []);
	}

	/** Returns a detached snapshot of the currently committed records. */
	snapshot(): readonly RecordType[] {
		return this.#cloneRecords(this.#records);
	}

	/** Atomically replaces the committed records with detached copies. */
	replace(records: readonly RecordType[]): void {
		this.#records = this.#cloneRecords(records);
	}

	clone(record: RecordType): RecordType {
		return this.#clone(record);
	}

	#cloneRecords(records: readonly RecordType[]): readonly RecordType[] {
		return records.map((record) => this.#clone(record));
	}
}
