import { BitbucketClient } from './bitbucket.js';
import { JiraClient } from './jira.js';
import { HealthError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { HealthConfig, IntegrationConfig } from '../config/types.js';

/**
 * Builds integration clients on demand and keeps one per id for the run, so a
 * repeated repository or summary reuses the same connection settings rather
 * than constructing a fresh client each time.
 */
export class IntegrationRegistry {
  private readonly byId: Map<string, IntegrationConfig>;
  private readonly bitbucket = new Map<string, BitbucketClient>();
  private readonly jira = new Map<string, JiraClient>();

  constructor(config: HealthConfig, private readonly logger: Logger) {
    this.byId = new Map(config.integrations.map((i) => [i.id, i]));
  }

  private require(id: string, type: IntegrationConfig['type']): IntegrationConfig {
    const integration = this.byId.get(id);
    if (!integration) throw new HealthError(`No integration with id "${id}"`);
    if (integration.type !== type) {
      throw new HealthError(`Integration "${id}" is of type ${integration.type}, expected ${type}`);
    }
    return integration;
  }

  bitbucketClient(id: string): BitbucketClient {
    let client = this.bitbucket.get(id);
    if (!client) {
      client = new BitbucketClient(this.require(id, 'bitbucket'), this.logger);
      this.bitbucket.set(id, client);
    }
    return client;
  }

  jiraClient(id: string): JiraClient {
    let client = this.jira.get(id);
    if (!client) {
      client = new JiraClient(this.require(id, 'jira'), this.logger);
      this.jira.set(id, client);
    }
    return client;
  }
}
