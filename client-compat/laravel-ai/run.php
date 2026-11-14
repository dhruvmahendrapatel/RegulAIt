<?php

// ADR-0257 — the Laravel AI SDK (laravel/ai), unmodified, pointed at the RegulAIt
// gateway through two of its own drivers:
//   - `openai-compatible` -> POST {url}/chat/completions
//   - `anthropic`         -> POST {url}/messages
//   - `openai` (its default) -> POST {url}/responses (ADR-0287), configured
//     with `store => false`: the gateway keeps no conversation state, so the
//     driver replays the whole history instead of a previous_response_id.
//
// The package is booted inside a minimal Testbench application, exactly as its
// own test suite boots it. Each check is printed as one JSON line; the harness
// asserts them and checks the ledger and the audit trail itself.

declare(strict_types=1);

require __DIR__.'/vendor/autoload.php';

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Http\Client\RequestException;
use Laravel\Ai\AiServiceProvider;
use Laravel\Ai\Contracts\Tool;
use Laravel\Ai\Streaming\Events\TextDelta;
use Laravel\Ai\Tools\Request;
use Orchestra\Testbench\Foundation\Application;

use function Laravel\Ai\agent;

function env_or_fail(string $key): string
{
    $v = getenv($key);
    if ($v === false || $v === '') {
        throw new RuntimeException("{$key} must be set");
    }

    return $v;
}

$gateway = env_or_fail('GATEWAY_URL');
$model = env_or_fail('MODEL');
$project = env_or_fail('PROJECT_ID');
$toolName = env_or_fail('TOOL_NAME');

$app = Application::create(basePath: __DIR__.'/vendor/orchestra/testbench-core/laravel', options: [
    'extra' => ['providers' => [AiServiceProvider::class]],
]);

/** One provider entry per (driver, key) — the SDK binds credentials to a configured provider. */
function provider(string $driver, string $url, string $key, string $project): array
{
    return [
        'driver' => $driver,
        'url' => $url,
        'key' => $key,
        'headers' => ['x-regulait-project-id' => $project],
        // the `openai` (Responses) driver: stateless, so no previous_response_id
        ...($driver === 'openai' ? ['store' => false] : []),
    ];
}

/** driver => env prefix of its allow/deny keys */
$drivers = ['openai-compatible' => 'OPENAI', 'anthropic' => 'ANTHROPIC', 'openai' => 'RESPONSES'];

$providers = [];
foreach ($drivers as $driver => $prefix) {
    $url = "{$gateway}/v1";
    $providers["rg-{$driver}-allow"] = provider($driver, $url, env_or_fail("{$prefix}_ALLOW_KEY"), $project);
    $providers["rg-{$driver}-deny"] = provider($driver, $url, env_or_fail("{$prefix}_DENY_KEY"), $project);
    $providers["rg-{$driver}-badkey"] = provider($driver, $url, 'rgk_not-a-real-key', $project);
}
$app['config']->set('ai.providers', array_merge($app['config']->get('ai.providers', []), $providers));

final class LookupTool implements Tool
{
    public static int $calls = 0;

    public function __construct(private string $name) {}

    public function name(): string
    {
        return $this->name;
    }

    public function description(): string
    {
        return 'look up a record';
    }

    public function handle(Request $request): string
    {
        self::$calls++;

        return 'record: p33';
    }

    public function schema(JsonSchema $schema): array
    {
        return [];
    }
}

$results = [];

function check(array &$results, string $name, callable $fn): void
{
    try {
        $results[] = ['name' => $name, 'ok' => true, 'detail' => $fn()];
    } catch (Throwable $e) {
        $results[] = ['name' => $name, 'ok' => false, 'detail' => get_class($e).': '.$e->getMessage()];
    }
}

function expect_true(bool $cond, string $msg): void
{
    if (! $cond) {
        throw new RuntimeException($msg);
    }
}

/** The refusal the SDK surfaces: an HTTP client exception carrying the status and the gateway's own message. */
function readable_refusal(Throwable $e, int $status): array
{
    $cause = $e;
    while ($cause !== null && ! $cause instanceof RequestException) {
        $cause = $cause->getPrevious();
    }
    expect_true($cause instanceof RequestException, 'expected an HTTP refusal, got '.get_class($e).': '.$e->getMessage());
    expect_true($cause->response->status() === $status, "expected {$status}, got ".$cause->response->status());
    $body = $cause->response->json();
    // ADR-0288: a 401 on a compat surface is in the provider's envelope too, so
    // every refusal carries a readable `error.message`.
    $message = $body['error']['message'] ?? null;
    expect_true(is_string($message) && strlen($message) > 10, 'unreadable error body: '.$cause->response->body());

    return ['status' => $status, 'type' => $body['error']['type'] ?? null, 'message' => substr($message, 0, 200)];
}

foreach (['openai-compatible' => 'openai', 'anthropic' => 'anthropic', 'openai' => 'responses'] as $driver => $label) {
    $p = "rg-{$driver}";

    check($results, "laravel.{$label}.auth", function () use ($p, $model, $label) {
        try {
            agent('You are terse.')->prompt("p33 laravel {$label} auth", provider: "{$p}-badkey", model: $model);
        } catch (Throwable $e) {
            return readable_refusal($e, 401);
        }
        throw new RuntimeException('an invalid key was accepted');
    });

    check($results, "laravel.{$label}.allow", function () use ($p, $model, $label) {
        $r = agent('You are terse.')->prompt("p33 laravel {$label} allow", provider: "{$p}-allow", model: $model);
        expect_true(strlen($r->text) > 0, 'empty response');
        expect_true($r->usage->inputTokens > 0, 'no usage');

        return ['text' => substr($r->text, 0, 80)];
    });

    check($results, "laravel.{$label}.deny", function () use ($p, $model, $label) {
        try {
            agent('You are terse.')->prompt("p33 laravel {$label} deny", provider: "{$p}-deny", model: $model);
        } catch (Throwable $e) {
            return readable_refusal($e, 403);
        }
        throw new RuntimeException('an ungranted caller was allowed');
    });

    check($results, "laravel.{$label}.stream", function () use ($p, $model, $label) {
        $deltas = 0;
        $text = '';
        foreach (agent('You are terse.')->stream("p33 laravel {$label} stream", provider: "{$p}-allow", model: $model) as $event) {
            if ($event instanceof TextDelta) {
                $deltas++;
                $text .= $event->delta;
            }
        }
        expect_true($deltas > 0 && $text !== '', "stream produced {$deltas} deltas");

        return ['deltas' => $deltas, 'text' => substr($text, 0, 80)];
    });

    check($results, "laravel.{$label}.tools", function () use ($p, $model, $toolName) {
        $before = LookupTool::$calls;
        $r = agent('You are terse.', tools: [new LookupTool($toolName)])
            ->prompt("look it up <<use-tool:{$toolName}>>", provider: "{$p}-allow", model: $model);
        expect_true(LookupTool::$calls === $before + 1, 'the tool was not invoked exactly once: '.(LookupTool::$calls - $before));
        expect_true($r->toolCalls->count() >= 1, 'no tool call recorded on the response');

        return ['tool' => $toolName, 'final' => substr($r->text, 0, 80)];
    });
}

fwrite(STDOUT, json_encode(['client' => 'laravel-ai', 'results' => $results])."\n");
