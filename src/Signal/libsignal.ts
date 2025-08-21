import * as libsignal from 'libsignal'
import {SignalAuthState, SignalKeyStoreWithTransaction} from '../Types'
import {SignalRepository} from '../Types/Signal'
import {generateSignalPubKey} from '../Utils'
import {jidDecode} from '../WABinary'
import type {SenderKeyStore} from './Group/group_cipher'
import {SenderKeyName} from './Group/sender-key-name'
import {SenderKeyRecord} from './Group/sender-key-record'
import {GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage} from './Group'

// Session recovery configuration
const SESSION_RECOVERY_CONFIG = {
	maxRetries: 4,
	baseDelayMs: 50,
	sessionRecordErrors: ['No session record', 'SessionError: No session record', 'No matching sessions', 'No session found'],
	macErrors: ['Bad MAC', 'MAC verification failed', 'Bad MAC Error'],
	allRecoverableErrors: [
		'No session record',
		'SessionError: No session record',
		'No session found',
		'Bad MAC',
		'MAC verification failed',
		'Bad MAC Error',
		'No matching sessions found for message'
	]
}

/**
 * Check if an error is recoverable (session record, MAC, or other signal errors)
 */
function isRecoverableSignalError(error: any): boolean {
	const errorMessage = error?.message || error?.toString() || '';
	return SESSION_RECOVERY_CONFIG.allRecoverableErrors.some(errorPattern =>
		errorMessage.includes(errorPattern)
	);
}

/**
 * Check if an error is specifically a MAC error
 */
function isMacError(error: any): boolean {
	const errorMessage = error?.message || error?.toString() || '';
	return SESSION_RECOVERY_CONFIG.macErrors.some(errorPattern =>
		errorMessage.includes(errorPattern)
	);
}

/**
 * Check if an error is related to missing session record
 */
function isSessionRecordError(error: any): boolean {
	const errorMessage = error?.message || error?.toString() || '';
	return SESSION_RECOVERY_CONFIG.sessionRecordErrors.some(errorPattern =>
		errorMessage.includes(errorPattern)
	);
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function makeLibSignalRepository(auth: SignalAuthState): SignalRepository {
	const storage: SenderKeyStore = signalStorage(auth)

	function isLikelySyncMessage(addr): boolean {
		const key = addr.toString();

		// Only bypass for WhatsApp system addresses, not regular user contacts
		// Be very specific about sync service patterns
		return key.includes('@lid.whatsapp.net') ||           // WhatsApp system messages
			key.includes('@broadcast') ||                   // Broadcast messages
			key.includes('@newsletter') ||                  // Newsletter messages
			key === 'status@broadcast' ||                   // Status updates
			key.includes('@g.us.history') ||               // Group history sync
			key.includes('.whatsapp.net.history');

	}

	/**
	 * Attempt to recover from session record errors by clearing the session
	 * and allowing libsignal to rebuild it on the next message
	 */
	async function attemptSessionRecovery(jid: string, error: any): Promise<void> {
		if (!isSessionRecordError(error)) {
			return;
		}

		try {
			const addr = jidToSignalProtocolAddress(jid);
			const sessionId = addr.toString();

			// Clear the corrupted session to allow recovery
			await auth.keys.set({session: {[sessionId]: null}});

			console.log(`[Session Recovery] Cleared corrupted session for ${jid}`);
		} catch (recoveryError) {
			console.warn(`[Session Recovery] Failed to clear session for ${jid}:`, recoveryError);
		}
	}

	/**
	 * Attempt to recover from various Signal errors including MAC errors
	 * For MAC errors, we clear the session to force re-establishment
	 * For session record errors, we also clear the session
	 */
	async function attemptSignalRecovery(jid: string, error: any): Promise<void> {
		if (!isRecoverableSignalError(error)) {
			return;
		}

		try {
			const addr = jidToSignalProtocolAddress(jid);
			const sessionId = addr.toString();

			if (isMacError(error)) {
				// For MAC errors, clear the session and force re-establishment
				await auth.keys.set({session: {[sessionId]: null}});
				console.log(`[MAC Recovery] Cleared session with MAC error for ${jid}`);
			} else if (isSessionRecordError(error)) {
				// For session record errors, clear the corrupted session
				await auth.keys.set({session: {[sessionId]: null}});
				console.log(`[Session Recovery] Cleared corrupted session for ${jid}`);
			}
		} catch (recoveryError) {
			console.warn(`[Signal Recovery] Failed to clear session for ${jid}:`, recoveryError);
		}
	}

	return {
		decryptGroupMessage({group, authorJid, msg}) {
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)

			// Use transaction to ensure atomicity
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				return cipher.decrypt(msg)
			}, group)
		},

		async processSenderKeyDistributionMessage({item, authorJid}) {
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) {
				throw new Error('Group ID is required for sender key distribution message')
			}

			const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)

			const senderMsg = new SenderKeyDistributionMessage(
				null,
				null,
				null,
				null,
				item.axolotlSenderKeyDistributionMessage
			)
			const senderNameStr = senderName.toString()

			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const {[senderNameStr]: senderKey} = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				await builder.process(senderName, senderMsg)
			}, item.groupId)
		},

		async decryptMessage({jid, type, ciphertext}) {
			const addr = jidToSignalProtocolAddress(jid)
			const session = new libsignal.SessionCipher(storage, addr)

			async function doDecrypt(): Promise<Buffer> {
				let result: Buffer
				switch (type) {
					case 'pkmsg':
						result = await session.decryptPreKeyWhisperMessage(ciphertext)
						break
					case 'msg':
						result = await session.decryptWhisperMessage(ciphertext)
						break
				}
				return result
			}

			// Enhanced decryption with comprehensive error recovery
			async function decryptWithRecovery(): Promise<Buffer> {
				let lastError: any;

				for (let attempt = 0; attempt <= SESSION_RECOVERY_CONFIG.maxRetries; attempt++) {
					try {
						return await doDecrypt();
					} catch (error) {
						lastError = error;

						// Only attempt recovery for recoverable Signal errors
						if (!isRecoverableSignalError(error)) {
							throw error;
						}

						// Don't retry on the last attempt
						if (attempt === SESSION_RECOVERY_CONFIG.maxRetries) {
							break;
						}

						// Enhanced logging with error type classification
						const errorType = isMacError(error) ? 'MAC' :
										 isSessionRecordError(error) ? 'Session Record' :
										 'Other Signal';

						console.warn(`[libsignal] ${errorType} error for ${jid}, attempt ${attempt + 1}/${SESSION_RECOVERY_CONFIG.maxRetries + 1}: ${error.message}`);

						// Attempt recovery based on error type
						await attemptSignalRecovery(jid, error);

						// Wait before retry with exponential backoff
						const delay = SESSION_RECOVERY_CONFIG.baseDelayMs * Math.pow(2, attempt);
						await sleep(delay);
					}
				}

				// If all retries failed, throw the last error
				throw lastError;
			}

			if (isLikelySyncMessage(addr)) {
				// If it's a sync message, we can skip the transaction and recovery
				// as it is likely to be a system message that doesn't require strict atomicity
				return await doDecrypt()
			}

			// For regular messages, use transaction and recovery mechanism
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				return await decryptWithRecovery()
			}, jid)
		},
		async encryptMessage({jid, data}) {
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new libsignal.SessionCipher(storage, addr)

			// Use transaction to ensure atomicityAdd commentMore actions
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const {type: sigType, body} = await cipher.encrypt(data)
				const type = sigType === 3 ? 'pkmsg' : 'msg'
				return {type, ciphertext: Buffer.from(body, 'binary')}
			}, jid)
		},
		async encryptGroupMessage({group, meId, data}) {
			const senderName = jidToSignalSenderKeyName(group, meId)
			const builder = new GroupSessionBuilder(storage)

			const senderNameStr = senderName.toString()

			// Use transaction to ensure atomicity
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const {[senderNameStr]: senderKey} = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				const senderKeyDistributionMessage = await builder.create(senderName)
				const session = new GroupCipher(storage, senderName)
				const ciphertext = await session.encrypt(data)

				return {
					ciphertext,
					senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
				}
			}, group)
		},
		async injectE2ESession({jid, session}) {
			const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))

			// Use transaction to ensure atomicity
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				await cipher.initOutgoing(session)
			}, jid)
		},
		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		}
	}
}

const jidToSignalProtocolAddress = (jid: string) => {
	const {user, device} = jidDecode(jid)!
	return new libsignal.ProtocolAddress(user, device || 0)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage({creds, keys}: SignalAuthState): SenderKeyStore & Record<string, any> {
	return {
		loadSession: async (id: string) => {
			const {[id]: sess} = await keys.get('session', [id])
			if (sess) {
				return libsignal.SessionRecord.deserialize(sess)
			}
		},
		storeSession: async (id: string, session: libsignal.SessionRecord) => {
			await keys.set({session: {[id]: session.serialize()}})
		},
		isTrustedIdentity: () => {
			return true
		},
		loadPreKey: async (id: number | string) => {
			const keyId = id.toString()
			const {[keyId]: key} = await keys.get('pre-key', [keyId])
			if (key) {
				return {
					privKey: Buffer.from(key.private),
					pubKey: Buffer.from(key.public)
				}
			}
		},
		removePreKey: (id: number) => keys.set({'pre-key': {[id]: null}}),
		loadSignedPreKey: () => {
			const key = creds.signedPreKey
			return {
				privKey: Buffer.from(key.keyPair.private),
				pubKey: Buffer.from(key.keyPair.public)
			}
		},
		loadSenderKey: async (senderKeyName: SenderKeyName) => {
			const keyId = senderKeyName.toString()
			const {[keyId]: key} = await keys.get('sender-key', [keyId])
			if (key) {
				return SenderKeyRecord.deserialize(key)
			}

			return new SenderKeyRecord()
		},
		storeSenderKey: async (senderKeyName: SenderKeyName, key: SenderKeyRecord) => {
			const keyId = senderKeyName.toString()
			const serialized = JSON.stringify(key.serialize())
			await keys.set({'sender-key': {[keyId]: Buffer.from(serialized, 'utf-8')}})
		},
		getOurRegistrationId: () => creds.registrationId,
		getOurIdentity: () => {
			const {signedIdentityKey} = creds
			return {
				privKey: Buffer.from(signedIdentityKey.private),
				pubKey: generateSignalPubKey(signedIdentityKey.public)
			}
		}
	}
}
