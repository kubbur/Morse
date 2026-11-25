import CryptoKit
import Foundation
import Security

// Use Sparkle's keychain format with a separate account for Morse.
let account = "digital.kubbur.morse"
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "https://sparkle-project.org",
    kSecAttrAccount as String: account,
    kSecAttrProtocol as String: kSecAttrProtocolSSH
]

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func check(_ status: OSStatus) {
    if status != errSecSuccess {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error"
        fail("\(message) (\(status))")
    }
}

func readKey() throws -> Curve25519.Signing.PrivateKey? {
    var result: CFTypeRef?
    var lookup = query
    lookup[kSecReturnData as String] = true
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    check(status)
    guard let data = result as? Data, let seed = Data(base64Encoded: data) else {
        fail("The Morse keychain item does not contain a Sparkle signing key.")
    }
    return try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
}

func store(_ key: Curve25519.Signing.PrivateKey) {
    var item = query
    item[kSecAttrLabel as String] = "Morse – Sparkle update signing key"
    item[kSecAttrComment as String] = "Morse public key: " + key.publicKey.rawRepresentation.base64EncodedString()
    item[kSecAttrIsSensitive as String] = true
    item[kSecValueData as String] = key.rawRepresentation.base64EncodedData()
    check(SecItemAdd(item as CFDictionary, nil))
}

let args = Array(CommandLine.arguments.dropFirst())
guard args == ["create"] || args == ["public-key"] || (args.count == 2 && args[0] == "sign") else {
    fail("Usage: MorseReleaseKey create | public-key | sign ARCHIVE")
}
do {
    var key = try readKey()
    if key == nil && args == ["create"] {
        let newKey = Curve25519.Signing.PrivateKey()
        store(newKey)
        key = try readKey()
        guard key?.publicKey.rawRepresentation == newKey.publicKey.rawRepresentation else {
            fail("The new Morse update key could not be read back from Keychain.")
        }
    }
    guard let key else { fail("No Morse update key in the login Keychain.") }
    if args[0] == "sign" {
        let archive = try Data(contentsOf: URL(fileURLWithPath: args[1]), options: .mappedIfSafe)
        let signature = try key.signature(for: archive)
        guard key.publicKey.isValidSignature(signature, for: archive) else {
            fail("The signature failed verification.")
        }
        print(signature.base64EncodedString())
    } else {
        print(key.publicKey.rawRepresentation.base64EncodedString())
    }
} catch {
    fail(error.localizedDescription)
}
