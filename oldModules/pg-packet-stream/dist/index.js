"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const stream_1 = require("stream");
const messages_1 = require("./messages");
const BufferReader_1 = require("./BufferReader");
const assert_1 = __importDefault(require("assert"));
// every message is prefixed with a single bye
const CODE_LENGTH = 1;
// every message has an int32 length which includes itself but does
// NOT include the code in the length
const LEN_LENGTH = 4;
const HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
const emptyBuffer = Buffer.allocUnsafe(0);
class PgPacketStream extends stream_1.Transform {
    constructor(opts) {
        var _a, _b;
        super(Object.assign(Object.assign({}, opts), { readableObjectMode: true }));
        this.remainingBuffer = emptyBuffer;
        this.reader = new BufferReader_1.BufferReader();
        if (((_a = opts) === null || _a === void 0 ? void 0 : _a.mode) === 'binary') {
            throw new Error('Binary mode not supported yet');
        }
        this.mode = ((_b = opts) === null || _b === void 0 ? void 0 : _b.mode) || 'text';
    }
    _transform(buffer, encoding, callback) {
        let combinedBuffer = buffer;
        if (this.remainingBuffer.byteLength) {
            combinedBuffer = Buffer.allocUnsafe(this.remainingBuffer.byteLength + buffer.byteLength);
            this.remainingBuffer.copy(combinedBuffer);
            buffer.copy(combinedBuffer, this.remainingBuffer.byteLength);
        }
        let offset = 0;
        while ((offset + HEADER_LENGTH) <= combinedBuffer.byteLength) {
            // code is 1 byte long - it identifies the message type
            const code = combinedBuffer[offset];
            // length is 1 Uint32BE - it is the length of the message EXCLUDING the code
            const length = combinedBuffer.readUInt32BE(offset + CODE_LENGTH);
            const fullMessageLength = CODE_LENGTH + length;
            if (fullMessageLength + offset <= combinedBuffer.byteLength) {
                const message = this.handlePacket(offset + HEADER_LENGTH, code, length, combinedBuffer);
                this.push(message);
                offset += fullMessageLength;
            }
            else {
                break;
            }
        }
        if (offset === combinedBuffer.byteLength) {
            this.remainingBuffer = emptyBuffer;
        }
        else {
            this.remainingBuffer = combinedBuffer.slice(offset);
        }
        callback(null);
    }
    handlePacket(offset, code, length, bytes) {
        switch (code) {
            case 50 /* BindComplete */:
                return messages_1.bindComplete;
            case 49 /* ParseComplete */:
                return messages_1.parseComplete;
            case 51 /* CloseComplete */:
                return messages_1.closeComplete;
            case 110 /* NoData */:
                return messages_1.noData;
            case 115 /* PortalSuspended */:
                return messages_1.portalSuspended;
            case 99 /* CopyDone */:
                return messages_1.copyDone;
            case 87 /* ReplicationStart */:
                return messages_1.replicationStart;
            case 73 /* EmptyQuery */:
                return messages_1.emptyQuery;
            case 68 /* DataRow */:
                return this.parseDataRowMessage(offset, length, bytes);
            case 67 /* CommandComplete */:
                return this.parseCommandCompleteMessage(offset, length, bytes);
            case 90 /* ReadyForQuery */:
                return this.parseReadyForQueryMessage(offset, length, bytes);
            case 65 /* NotificationResponse */:
                return this.parseNotificationMessage(offset, length, bytes);
            case 82 /* AuthenticationResponse */:
                return this.parseAuthenticationResponse(offset, length, bytes);
            case 83 /* ParameterStatus */:
                return this.parseParameterStatusMessage(offset, length, bytes);
            case 75 /* BackendKeyData */:
                return this.parseBackendKeyData(offset, length, bytes);
            case 69 /* ErrorMessage */:
                return this.parseErrorMessage(offset, length, bytes, "error" /* error */);
            case 78 /* NoticeMessage */:
                return this.parseErrorMessage(offset, length, bytes, "notice" /* notice */);
            case 84 /* RowDescriptionMessage */:
                return this.parseRowDescriptionMessage(offset, length, bytes);
            case 71 /* CopyIn */:
                return this.parseCopyInMessage(offset, length, bytes);
            case 72 /* CopyOut */:
                return this.parseCopyOutMessage(offset, length, bytes);
            case 100 /* CopyData */:
                return this.parseCopyData(offset, length, bytes);
            default:
                assert_1.default.fail(`unknown message code: ${code.toString(16)}`);
        }
    }
    _flush(callback) {
        this._transform(Buffer.alloc(0), 'utf-8', callback);
    }
    parseReadyForQueryMessage(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const status = this.reader.string(1);
        return new messages_1.ReadyForQueryMessage(length, status);
    }
    parseCommandCompleteMessage(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const text = this.reader.cstring();
        return new messages_1.CommandCompleteMessage(length, text);
    }
    parseCopyData(offset, length, bytes) {
        const chunk = bytes.slice(offset, offset + (length - 4));
        return new messages_1.CopyDataMessage(length, chunk);
    }
    parseCopyInMessage(offset, length, bytes) {
        return this.parseCopyMessage(offset, length, bytes, "copyInResponse" /* copyInResponse */);
    }
    parseCopyOutMessage(offset, length, bytes) {
        return this.parseCopyMessage(offset, length, bytes, "copyOutResponse" /* copyOutResponse */);
    }
    parseCopyMessage(offset, length, bytes, messageName) {
        this.reader.setBuffer(offset, bytes);
        const isBinary = this.reader.byte() !== 0;
        const columnCount = this.reader.int16();
        const message = new messages_1.CopyResponse(length, messageName, isBinary, columnCount);
        for (let i = 0; i < columnCount; i++) {
            message.columnTypes[i] = this.reader.int16();
        }
        return message;
    }
    parseNotificationMessage(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const processId = this.reader.int32();
        const channel = this.reader.cstring();
        const payload = this.reader.cstring();
        return new messages_1.NotificationResponseMessage(length, processId, channel, payload);
    }
    parseRowDescriptionMessage(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const fieldCount = this.reader.int16();
        const message = new messages_1.RowDescriptionMessage(length, fieldCount);
        for (let i = 0; i < fieldCount; i++) {
            message.fields[i] = this.parseField();
        }
        return message;
    }
    parseField() {
        const name = this.reader.cstring();
        const tableID = this.reader.int32();
        const columnID = this.reader.int16();
        const dataTypeID = this.reader.int32();
        const dataTypeSize = this.reader.int16();
        const dataTypeModifier = this.reader.int32();
        const mode = this.reader.int16() === 0 ? 'text' : 'binary';
        return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
    }
    parseDataRowMessage(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const fieldCount = this.reader.int16();
        const fields = new Array(fieldCount);
        for (let i = 0; i < fieldCount; i++) {
            const len = this.reader.int32();
            if (len === -1) {
                fields[i] = null;
            }
            else if (this.mode === 'text') {
                fields[i] = this.reader.string(len);
            }
        }
        return new messages_1.DataRowMessage(length, fields);
    }
    parseParameterStatusMessage(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const name = this.reader.cstring();
        const value = this.reader.cstring();
        return new messages_1.ParameterStatusMessage(length, name, value);
    }
    parseBackendKeyData(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const processID = this.reader.int32();
        const secretKey = this.reader.int32();
        return new messages_1.BackendKeyDataMessage(length, processID, secretKey);
    }
    parseAuthenticationResponse(offset, length, bytes) {
        this.reader.setBuffer(offset, bytes);
        const code = this.reader.int32();
        // TODO(bmc): maybe better types here
        const message = {
            name: "authenticationOk" /* authenticationOk */,
            length,
        };
        switch (code) {
            case 0: // AuthenticationOk
                break;
            case 3: // AuthenticationCleartextPassword
                if (message.length === 8) {
                    message.name = "authenticationCleartextPassword" /* authenticationCleartextPassword */;
                }
                break;
            case 5: // AuthenticationMD5Password
                if (message.length === 12) {
                    message.name = "authenticationMD5Password" /* authenticationMD5Password */;
                    const salt = this.reader.bytes(4);
                    return new messages_1.AuthenticationMD5Password(length, salt);
                }
                break;
            case 10: // AuthenticationSASL
                message.name = "authenticationSASL" /* authenticationSASL */;
                message.mechanisms = [];
                let mechanism;
                do {
                    mechanism = this.reader.cstring();
                    if (mechanism) {
                        message.mechanisms.push(mechanism);
                    }
                } while (mechanism);
                break;
            case 11: // AuthenticationSASLContinue
                message.name = "authenticationSASLContinue" /* authenticationSASLContinue */;
                message.data = this.reader.string(length - 4);
                break;
            case 12: // AuthenticationSASLFinal
                message.name = "authenticationSASLFinal" /* authenticationSASLFinal */;
                message.data = this.reader.string(length - 4);
                break;
            default:
                throw new Error('Unknown authenticationOk message type ' + code);
        }
        return message;
    }
    parseErrorMessage(offset, length, bytes, name) {
        this.reader.setBuffer(offset, bytes);
        var fields = {};
        var fieldType = this.reader.string(1);
        while (fieldType !== '\0') {
            fields[fieldType] = this.reader.cstring();
            fieldType = this.reader.string(1);
        }
        // the msg is an Error instance
        var message = new messages_1.DatabaseError(fields.M, length, name);
        message.severity = fields.S;
        message.code = fields.C;
        message.detail = fields.D;
        message.hint = fields.H;
        message.position = fields.P;
        message.internalPosition = fields.p;
        message.internalQuery = fields.q;
        message.where = fields.W;
        message.schema = fields.s;
        message.table = fields.t;
        message.column = fields.c;
        message.dataType = fields.d;
        message.constraint = fields.n;
        message.file = fields.F;
        message.line = fields.L;
        message.routine = fields.R;
        return message;
    }
}
exports.PgPacketStream = PgPacketStream;
//# sourceMappingURL=index.js.map