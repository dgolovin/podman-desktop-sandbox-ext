/**********************************************************************
 * Copyright (C) 2022 - 2023 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import * as extensionApi from '@podman-desktop/api';
import * as fs from 'fs-extra';
import * as jsYaml from 'js-yaml';
import got from 'got';

async function createOrLoadKubeConfig(kubeconfigFile = extensionApi.kubernetes.getKubeconfig().fsPath) {
  let config:any = {
    contexts: [],
    users: [],
    clusters: []
  };

  // Do not load from default locations if it is not present
  // It will be added later if sandbox url and token provided
  if (fs.existsSync(kubeconfigFile)) {
    const kubeConfigRawContent = await fs.readFileSync(kubeconfigFile, 'utf-8');
    config = jsYaml.load(kubeConfigRawContent);
  }
  return config;
}

export async function activate(extensionContext: extensionApi.ExtensionContext): Promise<void> {
  console.log('starting extension openshift-sandbox');
  let status: extensionApi.ProviderStatus = 'installed';

  const providerOptions: extensionApi.ProviderOptions = {
    name: 'Developer Sandbox',
    id: 'redhat.sandbox',
    status,
  };
  const provider = extensionApi.provider.createProvider(providerOptions);

  const LoginCommandParam = 'redhat.sandbox.login.command';
  const ContextNameParam = 'redhat.sandbox.context.name';

  const disposable = provider.setKubernetesProviderConnectionFactory({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: async (
      params: { [key: string]: any },
      _logger?: extensionApi.Logger,
      _token?: extensionApi.CancellationToken,
    ) => {
      // check if context name is provided
      if (!params[ContextNameParam]) {
        throw new Error('Context name is required.');
      }

      const config:any = await createOrLoadKubeConfig();

      // check if context name is unique
      const exitingContext = config.contexts.find((context: any) => context.name === params[ContextNameParam]);
      if(exitingContext) {
        throw new Error(`Context ${params[ContextNameParam]} already exists, please choose a different name.`);
      }

      // validate if login command is not empty
      const loginCommand: string = params[LoginCommandParam];
      if (loginCommand.trim().length === 0) {
        throw new Error('Login command is required.');
      }

      // parse login command to get api url and token
      const apiURLMatch = loginCommand.match(/--server=(.*)/);
      const tokenMatch = loginCommand.match(/--token=(.*)/);

      // validate if login command is valid
      if (!apiURLMatch || !tokenMatch) {
        throw new Error('Login command is invalid or missing required options --server and --token.');
      }

      // get parsed values
      const apiURL = apiURLMatch[1];
      const token = tokenMatch[1];

      // check if cluster is accessible
      const status = await isClusterAccessible(apiURL, token);

      // check if token is valid
      // TODO: uncomment when token validation is implemented

      // generate unique suffix for cluster and user
      // TODO: it might be better to update token for api url if it already exists
      // Question: should user be askeed about it?
      const suffix = Math.random().toString(36).substring(7);

      // update loaded kubeconfig 
      config.clusters.push({
        cluster: {
          server: apiURL,
        },
        name: `sandbox-cluster-${suffix}`, // generate a unique name for the cluster
        skipTLSVerify: true,
      }); // has unique name
      config.users.push({
        name: `sandbox-user-${suffix}`, // generate a unique name for the user
        user: {
          token,
        },
      }); // has unique name
      config.contexts.push({
        cluster: `sandbox-cluster-${suffix}`,
        user: `sandbox-user-${suffix}`,
        name: params[ContextNameParam],
      });
      
      // set current context if it is not set
      if (!config.currentContext) {
        config.currentContext = params[ContextNameParam];
      }

      const kubeconfigFile = extensionApi.kubernetes.getKubeconfig().fsPath;
      // should it be synced through the API?
      fs.writeFileSync(
        kubeconfigFile,jsYaml.dump(config, { noArrayIndent: true, quotingType: '"', lineWidth: -1 }),
        'utf-8',
      );

      provider.registerKubernetesProviderConnection({
        name: params[ContextNameParam],
        status: () => status,
        endpoint: {
          apiURL,
        },
        lifecycle: {
          delete: async () => {
            
            return;
          },
        },
      });
    },
    creationDisplayName: 'Sandbox',
    // emptyConnectionsMessage:
    //   'A free private OpenShift environment including one project and resource quota of 14 GB RAM, and 4 GB storage. It lasts for 30 days.\n\nSign up at [https://developers.redhat.com/developer-sandbox][https://developers.redhat.com/developer-sandbox].',
  });

  extensionApi.window.withProgress({ location: extensionApi.ProgressLocation.APP_ICON }, async (progress, cancelfTocken) => {
    progress.report({ message: 'Loading Developer Sandbox connections...', increment: 0 });
    const config:any = await createOrLoadKubeConfig();
    const sandBoxContexts = config.contexts
      .filter(context => {
        return context.cluster.startsWith('sandbox-cluster-');
      })
    let increment = 0;
    const sandboxConnectionPromises: Promise<extensionApi.KubernetesProviderConnection>[] = sandBoxContexts.map(async context => {
        const cluster = config.clusters.find(cluster => cluster.name === context.cluster);
        const user = config.users.find(user => user.name === context.user);
        const status = await isClusterAccessible(cluster.server, user.token);
        progress.report({ message: 'Loading Developer Sandbox connections...', increment: increment+= 100 / sandBoxContexts.length });
        return {
          name: context.name,
          status: () => status,
          endpoint: {
            apiURL: cluster.server,
          },
          lifecycle: {
            delete: async () => {
              // delete from kubeconfig when delete for remote resource is unlocked
              return;
            },
          },
        };
      });
    const sandboxConnections = await Promise.all(sandboxConnectionPromises);
    sandboxConnections.forEach(connection => provider.registerKubernetesProviderConnection(connection));
  });

  extensionApi.kubernetes.onDidUpdateKubeconfig((event: extensionApi.KubeconfigUpdateEvent) => {
    // update the tray everytime .kube/config file is updated
    if (event.type === 'UPDATE' || event.type === 'CREATE') {

    } else if (event.type === 'DELETE') {
      // TODO: remove sandbox connection from provider if it is deleted from kubeconfig
    }
  });
  extensionContext.subscriptions.push(provider);
}

async function isClusterAccessible(apiURL: string, token: string): Promise<extensionApi.ProviderConnectionStatus> {
  return got(apiURL, { headers: { Authorization: `Bearer ${token}` } }).then(response => {
    // TODO: check if token is valid by requestin whoami or GET /oapi/v1/projects or GET /apis/project.openshift.io/v1/projects
    // https://docs.openshift.com/container-platform/4.12/rest_api/index.html
    if (response.statusCode === 200) {
      return 'started';
    }
    return 'unknown';
  }).catch(() =>'unknown');
} 