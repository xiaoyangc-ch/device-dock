/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
import * as $protobuf from "protobufjs/minimal";

// Common aliases
const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const com = $root.com = (() => {

    /**
     * Namespace com.
     * @exports com
     * @namespace
     */
    const com = {};

    com.devicedock = (function() {

        /**
         * Namespace devicedock.
         * @memberof com
         * @namespace
         */
        const devicedock = {};

        devicedock.server = (function() {

            /**
             * Namespace server.
             * @memberof com.devicedock
             * @namespace
             */
            const server = {};

            server.Request = (function() {

                /**
                 * Properties of a Request.
                 * @memberof com.devicedock.server
                 * @interface IRequest
                 * @property {string|null} [id] Request id
                 * @property {string|null} [method] Request method
                 * @property {string|null} [params] Request params
                 */

                /**
                 * Constructs a new Request.
                 * @memberof com.devicedock.server
                 * @classdesc Represents a Request.
                 * @implements IRequest
                 * @constructor
                 * @param {com.devicedock.server.IRequest=} [properties] Properties to set
                 */
                function Request(properties) {
                    if (properties)
                        for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                            if (properties[keys[i]] != null && keys[i] !== "__proto__")
                                this[keys[i]] = properties[keys[i]];
                }

                /**
                 * Request id.
                 * @member {string} id
                 * @memberof com.devicedock.server.Request
                 * @instance
                 */
                Request.prototype.id = "";

                /**
                 * Request method.
                 * @member {string} method
                 * @memberof com.devicedock.server.Request
                 * @instance
                 */
                Request.prototype.method = "";

                /**
                 * Request params.
                 * @member {string} params
                 * @memberof com.devicedock.server.Request
                 * @instance
                 */
                Request.prototype.params = "";

                /**
                 * Creates a new Request instance using the specified properties.
                 * @function create
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {com.devicedock.server.IRequest=} [properties] Properties to set
                 * @returns {com.devicedock.server.Request} Request instance
                 */
                Request.create = function create(properties) {
                    return new Request(properties);
                };

                /**
                 * Encodes the specified Request message. Does not implicitly {@link com.devicedock.server.Request.verify|verify} messages.
                 * @function encode
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {com.devicedock.server.IRequest} message Request message or plain object to encode
                 * @param {$protobuf.Writer} [writer] Writer to encode to
                 * @returns {$protobuf.Writer} Writer
                 */
                Request.encode = function encode(message, writer, q) {
                    if (!writer)
                        writer = $Writer.create();
                    if (q === undefined)
                        q = 0;
                    if (q > $util.recursionLimit)
                        throw Error("max depth exceeded");
                    if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                        writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
                    if (message.method != null && Object.hasOwnProperty.call(message, "method"))
                        writer.uint32(/* id 2, wireType 2 =*/18).string(message.method);
                    if (message.params != null && Object.hasOwnProperty.call(message, "params"))
                        writer.uint32(/* id 3, wireType 2 =*/26).string(message.params);
                    return writer;
                };

                /**
                 * Encodes the specified Request message, length delimited. Does not implicitly {@link com.devicedock.server.Request.verify|verify} messages.
                 * @function encodeDelimited
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {com.devicedock.server.IRequest} message Request message or plain object to encode
                 * @param {$protobuf.Writer} [writer] Writer to encode to
                 * @returns {$protobuf.Writer} Writer
                 */
                Request.encodeDelimited = function encodeDelimited(message, writer) {
                    return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
                };

                /**
                 * Decodes a Request message from the specified reader or buffer.
                 * @function decode
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                 * @param {number} [length] Message length if known beforehand
                 * @returns {com.devicedock.server.Request} Request
                 * @throws {Error} If the payload is not a reader or valid buffer
                 * @throws {$protobuf.util.ProtocolError} If required fields are missing
                 */
                Request.decode = function decode(reader, length, error, long) {
                    if (!(reader instanceof $Reader))
                        reader = $Reader.create(reader);
                    if (long === undefined)
                        long = 0;
                    if (long > $Reader.recursionLimit)
                        throw Error("maximum nesting depth exceeded");
                    let end, message;
                    if (length === undefined)
                        end = reader.len;
                    else {
                        end = reader.pos + length;
                        if (end > reader.len)
                            throw RangeError("index out of range");
                        length = reader.len;
                        reader.len = end;
                    }
                    message = new $root.com.devicedock.server.Request();
                    while (reader.pos < end) {
                        let tag = reader.uint32();
                        if (tag === error)
                            break;
                        switch (tag >>> 3) {
                        case 1: {
                                message.id = reader.string();
                                break;
                            }
                        case 2: {
                                message.method = reader.string();
                                break;
                            }
                        case 3: {
                                message.params = reader.string();
                                break;
                            }
                        default:
                            reader.skipType(tag & 7, long);
                            break;
                        }
                    }
                    if (length !== undefined) {
                        if (reader.pos !== end)
                            throw RangeError("index out of range");
                        reader.len = length;
                    }
                    return message;
                };

                /**
                 * Decodes a Request message from the specified reader or buffer, length delimited.
                 * @function decodeDelimited
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                 * @returns {com.devicedock.server.Request} Request
                 * @throws {Error} If the payload is not a reader or valid buffer
                 * @throws {$protobuf.util.ProtocolError} If required fields are missing
                 */
                Request.decodeDelimited = function decodeDelimited(reader) {
                    if (!(reader instanceof $Reader))
                        reader = new $Reader(reader);
                    return this.decode(reader, reader.uint32());
                };

                /**
                 * Verifies a Request message.
                 * @function verify
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {Object.<string,*>} message Plain object to verify
                 * @returns {string|null} `null` if valid, otherwise the reason why it is not
                 */
                Request.verify = function verify(message, long) {
                    if (typeof message !== "object" || message === null)
                        return "object expected";
                    if (long === undefined)
                        long = 0;
                    if (long > $util.recursionLimit)
                        return "maximum nesting depth exceeded";
                    if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                        if (!$util.isString(message.id))
                            return "id: string expected";
                    if (message.method != null && Object.hasOwnProperty.call(message, "method"))
                        if (!$util.isString(message.method))
                            return "method: string expected";
                    if (message.params != null && Object.hasOwnProperty.call(message, "params"))
                        if (!$util.isString(message.params))
                            return "params: string expected";
                    return null;
                };

                /**
                 * Creates a Request message from a plain object. Also converts values to their respective internal types.
                 * @function fromObject
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {Object.<string,*>} object Plain object
                 * @returns {com.devicedock.server.Request} Request
                 */
                Request.fromObject = function fromObject(object, long) {
                    if (object instanceof $root.com.devicedock.server.Request)
                        return object;
                    if (!$util.isObject(object))
                        throw TypeError(".com.devicedock.server.Request: object expected");
                    if (long === undefined)
                        long = 0;
                    if (long > $util.recursionLimit)
                        throw Error("maximum nesting depth exceeded");
                    let message = new $root.com.devicedock.server.Request();
                    if (object.id != null)
                        message.id = String(object.id);
                    if (object.method != null)
                        message.method = String(object.method);
                    if (object.params != null)
                        message.params = String(object.params);
                    return message;
                };

                /**
                 * Creates a plain object from a Request message. Also converts values to other types if specified.
                 * @function toObject
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {com.devicedock.server.Request} message Request
                 * @param {$protobuf.IConversionOptions} [options] Conversion options
                 * @returns {Object.<string,*>} Plain object
                 */
                Request.toObject = function toObject(message, options, q) {
                    if (!options)
                        options = {};
                    if (q === undefined)
                        q = 0;
                    if (q > $util.recursionLimit)
                        throw Error("max depth exceeded");
                    let object = {};
                    if (options.defaults) {
                        object.id = "";
                        object.method = "";
                        object.params = "";
                    }
                    if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                        object.id = message.id;
                    if (message.method != null && Object.hasOwnProperty.call(message, "method"))
                        object.method = message.method;
                    if (message.params != null && Object.hasOwnProperty.call(message, "params"))
                        object.params = message.params;
                    return object;
                };

                /**
                 * Converts this Request to JSON.
                 * @function toJSON
                 * @memberof com.devicedock.server.Request
                 * @instance
                 * @returns {Object.<string,*>} JSON object
                 */
                Request.prototype.toJSON = function toJSON() {
                    return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
                };

                /**
                 * Gets the default type url for Request
                 * @function getTypeUrl
                 * @memberof com.devicedock.server.Request
                 * @static
                 * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                 * @returns {string} The default type url
                 */
                Request.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                    if (typeUrlPrefix === undefined) {
                        typeUrlPrefix = "type.googleapis.com";
                    }
                    return typeUrlPrefix + "/com.devicedock.server.Request";
                };

                return Request;
            })();

            server.Response = (function() {

                /**
                 * Properties of a Response.
                 * @memberof com.devicedock.server
                 * @interface IResponse
                 * @property {string|null} [id] Response id
                 * @property {string|null} [result] Response result
                 */

                /**
                 * Constructs a new Response.
                 * @memberof com.devicedock.server
                 * @classdesc Represents a Response.
                 * @implements IResponse
                 * @constructor
                 * @param {com.devicedock.server.IResponse=} [properties] Properties to set
                 */
                function Response(properties) {
                    if (properties)
                        for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                            if (properties[keys[i]] != null && keys[i] !== "__proto__")
                                this[keys[i]] = properties[keys[i]];
                }

                /**
                 * Response id.
                 * @member {string} id
                 * @memberof com.devicedock.server.Response
                 * @instance
                 */
                Response.prototype.id = "";

                /**
                 * Response result.
                 * @member {string} result
                 * @memberof com.devicedock.server.Response
                 * @instance
                 */
                Response.prototype.result = "";

                /**
                 * Creates a new Response instance using the specified properties.
                 * @function create
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {com.devicedock.server.IResponse=} [properties] Properties to set
                 * @returns {com.devicedock.server.Response} Response instance
                 */
                Response.create = function create(properties) {
                    return new Response(properties);
                };

                /**
                 * Encodes the specified Response message. Does not implicitly {@link com.devicedock.server.Response.verify|verify} messages.
                 * @function encode
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {com.devicedock.server.IResponse} message Response message or plain object to encode
                 * @param {$protobuf.Writer} [writer] Writer to encode to
                 * @returns {$protobuf.Writer} Writer
                 */
                Response.encode = function encode(message, writer, q) {
                    if (!writer)
                        writer = $Writer.create();
                    if (q === undefined)
                        q = 0;
                    if (q > $util.recursionLimit)
                        throw Error("max depth exceeded");
                    if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                        writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
                    if (message.result != null && Object.hasOwnProperty.call(message, "result"))
                        writer.uint32(/* id 2, wireType 2 =*/18).string(message.result);
                    return writer;
                };

                /**
                 * Encodes the specified Response message, length delimited. Does not implicitly {@link com.devicedock.server.Response.verify|verify} messages.
                 * @function encodeDelimited
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {com.devicedock.server.IResponse} message Response message or plain object to encode
                 * @param {$protobuf.Writer} [writer] Writer to encode to
                 * @returns {$protobuf.Writer} Writer
                 */
                Response.encodeDelimited = function encodeDelimited(message, writer) {
                    return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
                };

                /**
                 * Decodes a Response message from the specified reader or buffer.
                 * @function decode
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                 * @param {number} [length] Message length if known beforehand
                 * @returns {com.devicedock.server.Response} Response
                 * @throws {Error} If the payload is not a reader or valid buffer
                 * @throws {$protobuf.util.ProtocolError} If required fields are missing
                 */
                Response.decode = function decode(reader, length, error, long) {
                    if (!(reader instanceof $Reader))
                        reader = $Reader.create(reader);
                    if (long === undefined)
                        long = 0;
                    if (long > $Reader.recursionLimit)
                        throw Error("maximum nesting depth exceeded");
                    let end, message;
                    if (length === undefined)
                        end = reader.len;
                    else {
                        end = reader.pos + length;
                        if (end > reader.len)
                            throw RangeError("index out of range");
                        length = reader.len;
                        reader.len = end;
                    }
                    message = new $root.com.devicedock.server.Response();
                    while (reader.pos < end) {
                        let tag = reader.uint32();
                        if (tag === error)
                            break;
                        switch (tag >>> 3) {
                        case 1: {
                                message.id = reader.string();
                                break;
                            }
                        case 2: {
                                message.result = reader.string();
                                break;
                            }
                        default:
                            reader.skipType(tag & 7, long);
                            break;
                        }
                    }
                    if (length !== undefined) {
                        if (reader.pos !== end)
                            throw RangeError("index out of range");
                        reader.len = length;
                    }
                    return message;
                };

                /**
                 * Decodes a Response message from the specified reader or buffer, length delimited.
                 * @function decodeDelimited
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                 * @returns {com.devicedock.server.Response} Response
                 * @throws {Error} If the payload is not a reader or valid buffer
                 * @throws {$protobuf.util.ProtocolError} If required fields are missing
                 */
                Response.decodeDelimited = function decodeDelimited(reader) {
                    if (!(reader instanceof $Reader))
                        reader = new $Reader(reader);
                    return this.decode(reader, reader.uint32());
                };

                /**
                 * Verifies a Response message.
                 * @function verify
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {Object.<string,*>} message Plain object to verify
                 * @returns {string|null} `null` if valid, otherwise the reason why it is not
                 */
                Response.verify = function verify(message, long) {
                    if (typeof message !== "object" || message === null)
                        return "object expected";
                    if (long === undefined)
                        long = 0;
                    if (long > $util.recursionLimit)
                        return "maximum nesting depth exceeded";
                    if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                        if (!$util.isString(message.id))
                            return "id: string expected";
                    if (message.result != null && Object.hasOwnProperty.call(message, "result"))
                        if (!$util.isString(message.result))
                            return "result: string expected";
                    return null;
                };

                /**
                 * Creates a Response message from a plain object. Also converts values to their respective internal types.
                 * @function fromObject
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {Object.<string,*>} object Plain object
                 * @returns {com.devicedock.server.Response} Response
                 */
                Response.fromObject = function fromObject(object, long) {
                    if (object instanceof $root.com.devicedock.server.Response)
                        return object;
                    if (!$util.isObject(object))
                        throw TypeError(".com.devicedock.server.Response: object expected");
                    if (long === undefined)
                        long = 0;
                    if (long > $util.recursionLimit)
                        throw Error("maximum nesting depth exceeded");
                    let message = new $root.com.devicedock.server.Response();
                    if (object.id != null)
                        message.id = String(object.id);
                    if (object.result != null)
                        message.result = String(object.result);
                    return message;
                };

                /**
                 * Creates a plain object from a Response message. Also converts values to other types if specified.
                 * @function toObject
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {com.devicedock.server.Response} message Response
                 * @param {$protobuf.IConversionOptions} [options] Conversion options
                 * @returns {Object.<string,*>} Plain object
                 */
                Response.toObject = function toObject(message, options, q) {
                    if (!options)
                        options = {};
                    if (q === undefined)
                        q = 0;
                    if (q > $util.recursionLimit)
                        throw Error("max depth exceeded");
                    let object = {};
                    if (options.defaults) {
                        object.id = "";
                        object.result = "";
                    }
                    if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                        object.id = message.id;
                    if (message.result != null && Object.hasOwnProperty.call(message, "result"))
                        object.result = message.result;
                    return object;
                };

                /**
                 * Converts this Response to JSON.
                 * @function toJSON
                 * @memberof com.devicedock.server.Response
                 * @instance
                 * @returns {Object.<string,*>} JSON object
                 */
                Response.prototype.toJSON = function toJSON() {
                    return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
                };

                /**
                 * Gets the default type url for Response
                 * @function getTypeUrl
                 * @memberof com.devicedock.server.Response
                 * @static
                 * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                 * @returns {string} The default type url
                 */
                Response.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                    if (typeUrlPrefix === undefined) {
                        typeUrlPrefix = "type.googleapis.com";
                    }
                    return typeUrlPrefix + "/com.devicedock.server.Response";
                };

                return Response;
            })();

            return server;
        })();

        return devicedock;
    })();

    return com;
})();

export { $root as default };
