/**
 * Browser-trust fence for the gitee-chat routes, behaviorally identical to the
 * /api gateway's fence in @deepseek-ai/dsh-client-connection (Host-header
 * loopback or a configured trusted authority passes; cross-site browser
 * markers refuse). This is a DNS-rebinding / cross-site defense, not
 * authentication.
 *
 * Copied (not imported) because that package does not export these helpers and
 * a plugin must not depend on another package's internals. Same file as the
 * one proven in dsh-gitee-sidebar.
 *
 * @module dsh-gitee-chat/host/trust-fence
 */
/** The request facts the fence reads (structural subset of IncomingMessage). */
export interface ApiTrustRequest {
    headers: Record<string, string | string[] | undefined>;
}
/** Whether a normalized URL hostname names the local loopback authority. */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * Decide whether one gitee-chat request may reach the plugin routes.
 * @param request - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
export declare function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean;
