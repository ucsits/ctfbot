import { describe, it, expect } from 'vitest';
import { formatError, isKnownError } from '../../src/lib/errorHandler.js';
import { ConfigurationError } from '../../src/config/index.js';
import { CTFChannelError } from '../../src/lib/middleware/ensureCTFChannel.js';
import { PermissionError } from '../../src/lib/middleware/ensurePermission.js';
import { CTFNotFoundError } from '../../src/lib/helpers/getCTFForChannel.js';
import { ValidationError, DatabaseError, ExternalAPIError } from '../../src/lib/errors/index.js';

describe('Error Handler', () => {
	describe('formatError', () => {
		it('should return error message when error has message', () => {
			const error = new Error('Test error');
			const result = formatError(error);
			expect(result).toBe('Test error');
		});

		it('should return default message when error has no message', () => {
			const error = new Error();
			const result = formatError(error);
			expect(result).toBe('❌ An unknown error occurred. Please try again later.');
		});

		it('should return default message when error is null', () => {
			const result = formatError(null);
			expect(result).toBe('❌ An unknown error occurred. Please try again later.');
		});
	});

	describe('isKnownError', () => {
		it('should return true for known error types', () => {
			const configError = new Error();
			configError.name = 'ConfigurationError';

			const channelError = new Error();
			channelError.name = 'CTFChannelError';

			const permError = new Error();
			permError.name = 'PermissionError';

			const notFoundError = new Error();
			notFoundError.name = 'CTFNotFoundError';

			const knownErrors = [configError, channelError, permError, notFoundError];

			for (const error of knownErrors) {
				expect(isKnownError(error)).toBe(true);
			}
		});

		it('should return false for unknown error types', () => {
			const error = new Error('Unknown error');
			expect(isKnownError(error)).toBe(false);
		});
	});
});
