// ADR-0257 — dart_mcp (dart-lang/ai, BSD-3-Clause), unmodified, as an MCP client
// against the RegulAIt gateway's governed MCP endpoint (`POST /mcp/:serverId`).
//
// dart_mcp 0.5.2 ships only a stdio transport: `MCPClient.connectServer` takes any
// `StreamChannel<String>` of JSON-RPC messages. The MCP Streamable HTTP transport
// is therefore supplied here, as the smallest channel that speaks it: each
// outgoing message is one POST; a JSON body or an SSE stream of messages comes
// back. Everything above the channel (initialize, tools/list, tools/call, error
// mapping) is dart_mcp's own code.
//
// Each check is printed as one JSON line; the harness asserts the checks and
// then checks the usage ledger and the audit trail itself.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dart_mcp/client.dart';
import 'package:json_rpc_2/json_rpc_2.dart' show RpcException;
import 'package:stream_channel/stream_channel.dart';

String envOrFail(String key) {
  final v = Platform.environment[key];
  if (v == null || v.isEmpty) throw StateError('$key must be set');
  return v;
}

/// The MCP Streamable HTTP transport as a `StreamChannel<String>`.
class StreamableHttpChannel extends StreamChannelMixin<String> {
  StreamableHttpChannel(this.endpoint, this.headers) {
    _outgoing.stream.listen(_post, onDone: _close);
  }

  final Uri endpoint;
  final Map<String, String> headers;
  final _http = HttpClient();
  final _incoming = StreamController<String>();
  final _outgoing = StreamController<String>();
  String? _sessionId;

  /// How many responses arrived as `text/event-stream` (the streamed path).
  int sseResponses = 0;
  int jsonResponses = 0;

  @override
  Stream<String> get stream => _incoming.stream;
  @override
  StreamSink<String> get sink => _outgoing.sink;

  Future<void> _post(String message) async {
    final decoded = jsonDecode(message) as Map<String, Object?>;
    final id = decoded['id'];
    try {
      final req = await _http.postUrl(endpoint);
      req.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
      req.headers.set(HttpHeaders.acceptHeader, 'application/json, text/event-stream');
      headers.forEach(req.headers.set);
      if (_sessionId != null) req.headers.set('mcp-session-id', _sessionId!);
      req.write(message);
      final res = await req.close();
      final sid = res.headers.value('mcp-session-id');
      if (sid != null) _sessionId = sid;
      final body = await res.transform(utf8.decoder).join();
      if (res.statusCode == 202) return; // a notification, accepted
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // A transport-level refusal (401/403) answers no JSON-RPC message; surface
        // it to dart_mcp as an error on the request it refused, with the
        // gateway's own words, so the caller sees a readable failure.
        if (id != null) {
          _incoming.add(jsonEncode({
            'jsonrpc': '2.0',
            'id': id,
            'error': {'code': -32001, 'message': 'HTTP ${res.statusCode}: $body'},
          }));
        }
        return;
      }
      final type = res.headers.contentType?.mimeType ?? '';
      if (type == 'text/event-stream') {
        sseResponses++;
        for (final event in body.split(RegExp(r'\r?\n\r?\n'))) {
          final data = event
              .split(RegExp(r'\r?\n'))
              .where((l) => l.startsWith('data:'))
              .map((l) => l.substring(5).trimLeft())
              .join('\n');
          if (data.isNotEmpty) _incoming.add(data);
        }
      } else if (body.isNotEmpty) {
        jsonResponses++;
        _incoming.add(body);
      }
    } catch (e) {
      if (id != null) {
        _incoming.add(jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'error': {'code': -32002, 'message': 'transport: $e'},
        }));
      }
    }
  }

  void _close() {
    _http.close(force: true);
    _incoming.close();
  }
}

final results = <Map<String, Object?>>[];

Future<void> check(String name, Future<Object?> Function() fn) async {
  try {
    results.add({'name': name, 'ok': true, 'detail': await fn()});
  } catch (e) {
    results.add({'name': name, 'ok': false, 'detail': '$e'});
  }
}

void expect(bool cond, String msg) {
  if (!cond) throw StateError(msg);
}

String textOf(CallToolResult r) =>
    r.content.where((c) => c.isText).map((c) => (c as TextContent).text).join();

Future<void> main() async {
  final gateway = envOrFail('GATEWAY_URL');
  final serverId = envOrFail('MCP_SERVER_ID');
  final project = envOrFail('PROJECT_ID');
  final allowedTool = envOrFail('MCP_ALLOWED_TOOL');
  final deniedTool = envOrFail('MCP_DENIED_TOOL');
  final endpoint = Uri.parse('$gateway/mcp/$serverId');

  Future<(ServerConnection, StreamableHttpChannel, MCPClient)> connect(String key) async {
    final client = MCPClient(Implementation(name: 'regulait-p33-dart-mcp', version: '0.0.1'));
    final channel = StreamableHttpChannel(endpoint, {
      'authorization': 'Bearer $key',
      'x-regulait-project-id': project,
    });
    final conn = client.connectServer(channel);
    final init = await conn.initialize(InitializeRequest(
      protocolVersion: ProtocolVersion.latestSupported,
      capabilities: client.capabilities,
      clientInfo: client.implementation,
    ));
    expect(init.protocolVersion?.isSupported == true, 'unsupported protocol ${init.protocolVersion}');
    conn.notifyInitialized();
    return (conn, channel, client);
  }

  await check('mcp.auth', () async {
    try {
      final (_, _, client) = await connect('rgk_not-a-real-key');
      await client.shutdown();
    } catch (e) {
      final msg = '$e';
      expect(msg.contains('401'), 'expected a 401 refusal, got: $msg');
      return {'message': msg.length > 200 ? msg.substring(0, 200) : msg};
    }
    throw StateError('an invalid key was accepted');
  });

  final (conn, channel, client) = await connect(envOrFail('MCP_ALLOW_KEY'));

  await check('mcp.allow', () async {
    final tools = await conn.listTools();
    final names = tools.tools.map((t) => t.name).toList();
    expect(names.contains(allowedTool), 'granted tool not listed: $names');
    expect(!names.contains(deniedTool), 'ungranted tool is visible: $names');
    final r = await conn.callTool(CallToolRequest(name: allowedTool, arguments: {}));
    expect(r.isError != true, 'granted call errored: ${textOf(r)}');
    expect(textOf(r).isNotEmpty, 'empty tool result');
    return {'listed': names, 'result': textOf(r)};
  });

  await check('mcp.deny', () async {
    try {
      final r = await conn.callTool(CallToolRequest(name: deniedTool, arguments: {'text': 'p33'}));
      // A tool-level error result is also a clean refusal, as long as it says why.
      expect(r.isError == true, 'an ungranted call was allowed: ${textOf(r)}');
      expect(textOf(r).isNotEmpty, 'refusal without a reason');
      return {'isError': true, 'message': textOf(r)};
    } on RpcException catch (e) {
      expect(e.message.isNotEmpty && e.message.toLowerCase().contains('denied'), 'unreadable refusal: ${e.message}');
      return {'code': e.code, 'message': e.message};
    }
  });

  await check('mcp.stream', () async {
    // The gateway answers requests on the Streamable HTTP transport's SSE path;
    // every response above arrived as an event stream and was parsed as one.
    expect(channel.sseResponses > 0, 'no response arrived as text/event-stream (json: ${channel.jsonResponses})');
    return {'sse': channel.sseResponses, 'json': channel.jsonResponses};
  });

  await check('mcp.tools', () async {
    final tools = await conn.listTools();
    final t = tools.tools.firstWhere((t) => t.name == allowedTool);
    final schema = jsonDecode(jsonEncode(t.inputSchema)) as Map<String, Object?>;
    expect(schema['type'] == 'object', 'tool schema is not an object: $schema');
    final r = await conn.callTool(CallToolRequest(name: allowedTool, arguments: {}));
    return {'tool': t.name, 'result': textOf(r)};
  });

  await client.shutdown();
  stdout.writeln(jsonEncode({'client': 'dart-mcp', 'results': results}));
  await stdout.flush();
  exit(0);
}
