import { makeLibSignalRepository } from '../Signal/libsignal'
import { SignalAuthState, SignalDataTypeMap } from '../Types'
import { Curve, generateRegistrationId, generateSignalPubKey, signedKeyPair } from '../Utils'
import { addTransactionCapability } from '../Utils/auth-utils'
import { ILogger } from '../Utils/logger'

describe('Sender Key Fix Tests', () => {
	it('should handle forwarded messages with sender key distribution', async () => {
		const groupId = '123456@g.us'
		const participants = [...Array(3)].map(makeUser)
		
		const sender = participants[0]
		const forwarder = participants[1]
		const receiver = participants[2]

		const msg = Buffer.from('hello there with links!')

		// Step 1: Sender encrypts a group message
		const enc = await sender.repository.encryptGroupMessage({
			group: groupId,
			meId: sender.jid,
			data: msg
		})

		// Step 2: Forwarder processes the sender key distribution message and decrypts
		await forwarder.repository.processSenderKeyDistributionMessage({
			item: {
				groupId,
				axolotlSenderKeyDistributionMessage: enc.senderKeyDistributionMessage
			},
			authorJid: sender.jid
		})

		const decryptedByForwarder = await forwarder.repository.decryptGroupMessage({
			group: groupId,
			authorJid: sender.jid,
			msg: enc.ciphertext
		})
		expect(decryptedByForwarder).toEqual(msg)

		// Step 3: Forwarder re-encrypts the message (simulating forwarding)
		const forwardedEnc = await forwarder.repository.encryptGroupMessage({
			group: groupId,
			meId: forwarder.jid,
			data: msg
		})

		// Step 4: Receiver processes forwarder's sender key distribution message
		await receiver.repository.processSenderKeyDistributionMessage({
			item: {
				groupId,
				axolotlSenderKeyDistributionMessage: forwardedEnc.senderKeyDistributionMessage
			},
			authorJid: forwarder.jid
		})

		// Step 5: Receiver should be able to decrypt the forwarded message
		const decryptedByReceiver = await receiver.repository.decryptGroupMessage({
			group: groupId,
			authorJid: forwarder.jid,
			msg: forwardedEnc.ciphertext
		})
		expect(decryptedByReceiver).toEqual(msg)
	})

	it('should not throw "No session found" error when sender key states exist', async () => {
		const groupId = '123456@g.us'
		const participants = [...Array(2)].map(makeUser)
		
		const sender = participants[0]
		const receiver = participants[1]

		const msg = Buffer.from('test message')

		// Encrypt message
		const enc = await sender.repository.encryptGroupMessage({
			group: groupId,
			meId: sender.jid,
			data: msg
		})

		// Process sender key distribution message first
		await receiver.repository.processSenderKeyDistributionMessage({
			item: {
				groupId,
				axolotlSenderKeyDistributionMessage: enc.senderKeyDistributionMessage
			},
			authorJid: sender.jid
		})

		// This should not throw "No session found to decrypt message"
		const decrypted = await receiver.repository.decryptGroupMessage({
			group: groupId,
			authorJid: sender.jid,
			msg: enc.ciphertext
		})
		
		expect(decrypted).toEqual(msg)
	})

	it('should handle echo messages (decrypt own messages)', async () => {
		const groupId = '120363419479820185@g.us'
		const sender = makeUser()

		const msg = Buffer.from('hello there with links!')

		// Step 1: Sender encrypts a group message
		const enc = await sender.repository.encryptGroupMessage({
			group: groupId,
			meId: sender.jid,
			data: msg
		})

		// Step 2: Sender should be able to decrypt their own message (echo scenario)
		// This simulates receiving an echo of your own message from WhatsApp
		const decryptedEcho = await sender.repository.decryptGroupMessage({
			group: groupId,
			authorJid: sender.jid,
			msg: enc.ciphertext
		})
		
		expect(decryptedEcho).toEqual(msg)
	})

	it('should handle the exact scenario from user log', async () => {
		// Simulating the exact scenario from the user's log
		const groupId = '120363419479820185@g.us'
		const userJid = '553171670477:14@s.whatsapp.net'
		const sender = makeUser()
		// Override the jid to match the log
		sender.jid = userJid

		const msg = Buffer.from('Test message with links')

		// Step 1: User sends a message to the group
		const enc = await sender.repository.encryptGroupMessage({
			group: groupId,
			meId: sender.jid,
			data: msg
		})

		// Step 2: WhatsApp sends back an echo of the message (fromMe: true)
		// This should NOT throw "No session found to decrypt message"
		const decryptedEcho = await sender.repository.decryptGroupMessage({
			group: groupId,
			authorJid: sender.jid,
			msg: enc.ciphertext
		})
		
		expect(decryptedEcho).toEqual(msg)
	})
})

type User = ReturnType<typeof makeUser>

function makeUser() {
	const store = makeTestAuthState()
	const jid = `${Math.random().toString().replace('.', '')}@s.whatsapp.net`
	const repository = makeLibSignalRepository(store)
	return { store, jid, repository }
}

function makeTestAuthState(): SignalAuthState {
	const identityKey = Curve.generateKeyPair()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const store: { [_: string]: any } = {}
	
	const logger: ILogger = {
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
		level: 'info'
	}
	
	const baseKeys = {
		async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
			const data: { [id: string]: SignalDataTypeMap[T] } = {}
			for (const id of ids) {
				const item = store[getUniqueId(type, id)]
				if (typeof item !== 'undefined') {
					data[id] = item
				}
			}

			return data
		},
		async set(data: any) {
			for (const type in data) {
				for (const id in data[type]) {
					store[getUniqueId(type, id)] = data[type][id]
				}
			}
		}
	}
	
	const keysWithTransaction = addTransactionCapability(baseKeys, logger, {
		maxCommitRetries: 5,
		delayBetweenTriesMs: 200
	})
	
	return {
		creds: {
			signedIdentityKey: identityKey,
			registrationId: generateRegistrationId(),
			signedPreKey: signedKeyPair(identityKey, 1)
		},
		keys: keysWithTransaction
	}

	function getUniqueId(type: string, id: string) {
		return `${type}.${id}`
	}
}
