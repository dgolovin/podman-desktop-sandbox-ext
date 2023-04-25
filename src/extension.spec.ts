/**********************************************************************
 * Copyright (C) 2023 Red Hat, Inc.
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

import { afterEach,  expect, test, vi } from 'vitest';

import { ProgressLocation, window as pdWindow, containerEngine, provider, KubernetesProviderConnectionFactory, ProviderOptions, Provider, Disposable, ProgressOptions, Progress, CancellationToken} from '@podman-desktop/api';
import { KubernetesProviderConnection } from '@podman-desktop/api';
import * as jsyaml from 'js-yaml';

const DefaultKubeconfigObject = {
  apiVersion: 'v1',
  clusters: [{
    cluster: {
      server: 'https://localhost:6443'
    },
    name: 'cluster1',
    skipTLSVerify: true,
  },],
  users: [{
    name: 'user1',
    user: {
      token: 'token'
    },
  },],
  contexts: [{
    name: 'context1',
    user: 'user', 
    cluster: 'cluster'
  }],
  currrentContext: 'context1',
};

const DefaultKubeconfigObjectWithSandbox = {
  apiVersion: 'v1',
  clusters: [{
    cluster: {
      server: 'https://sandbox-openshift-cluster:6443'
    },
    name: 'sandbox-cluster-12345',
    skipTLSVerify: true,
  },],
  users: [{
    name: 'sandbox-user-12345',
    user: {
      token: 'token'
    },
  },],
  contexts: [{
    name: 'sandbox-context-user-provided',
    user: 'sandbox-user-12345', 
    cluster: 'sandbox-cluster-12345'
  }],
  currrentContext: 'context1',
};


class ExtensionApiMock {
  public providerInstace;
  public providerInstanceFactory;
  public window;
  public windowWithProgress;
  public provider;
  public ProgressLocation = {
    APP_ICON: 1,
  };
  public kubernetes;
  public providerConnections = new Map<string, KubernetesProviderConnection>();
  public kubeconfigPath: string;
  constructor() {
    this.kubernetes = {
      getKubeconfig: vi.fn().mockImplementation(() => {
        return { fsPath: this.kubeconfigPath};
      }),
      onDidUpdateKubeconfig: () => {  }
    };
    this.window = {
      withProgress: vi.fn(),
    };
    this.provider = {
      createProvider:() => {
        this.providerInstace = {
          setKubernetesProviderConnectionFactory: vi.fn().mockImplementation((factory) => {
            this.providerInstanceFactory = factory;
          }),
          registerKubernetesProviderConnection: vi.fn().mockImplementation((connection: KubernetesProviderConnection) => {
            this.providerConnections.set(connection.name, connection);
          }),
        };
        return this.providerInstace;
      },
    };
  }

  public reset() {
    this.providerConnections.clear();
    this.providerConnections.clear();
    this.kubeconfigPath = undefined;
    this.windowWithProgress = undefined;
  }
}

let mockApi: ExtensionApiMock;
let mockFsExtra: any;
let mockReadFileSync: any;

vi.mock('@podman-desktop/api', async () => {
  mockApi = new ExtensionApiMock()
  return mockApi;
});

vi.mock('fs-extra', async () => {
  mockFsExtra = {
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockImplementation((path: string) => {
      return path.includes('exists');
    }),
    readFileSync: vi.fn().mockImplementation((path: string) => {
      if (path.includes('exists')) {
        return jsyaml.dump(DefaultKubeconfigObject);
      }
      throw new Error('File not found');    
    }),
  };
  return mockFsExtra;

});

const extensionContext = {
  subscriptions: [] as Disposable[],
  storagePath: '/tmp',
};

afterEach(() => {
  mockApi.reset();
});

test('exension sets setKubernetesProviderConnectionFactory', async () => {
  const extension = await import('./extension');
  await extension.activate(extensionContext);
  expect(mockApi.providerInstace.setKubernetesProviderConnectionFactory).toHaveBeenCalled();
});

test('extension creates kubeconfig, saves connected sandbox to it and register connection', async () => {
  const extension = await import('./extension');
  await extension.activate(extensionContext);
  mockApi.kubeconfigPath = '/tmp/kubeconfig';
  const fsReadFileSyncSpy = vi.spyOn(mockFsExtra, 'readFileSync');
  const fsWriteFileSyncSpy = vi.spyOn(mockFsExtra, 'writeFileSync');
  const registerConnectionSpy = vi.spyOn(mockApi.providerInstace,'registerKubernetesProviderConnection');

  await mockApi.providerInstanceFactory.create({
    'redhat.sandbox.login.command': '--server=https://api.sandbox.redhat.com:6443 --token=token',
    'redhat.sandbox.context.name': 'sandbox',
  });

  expect(registerConnectionSpy).toHaveBeenCalled();
  expect(fsReadFileSyncSpy).not.toHaveBeenCalled();
  expect(fsWriteFileSyncSpy).toHaveBeenCalled();
});

test('extension reads kubeconfig, saves connected sandbox to it and register connection', async () => {
  const extension = await import('./extension');
  await extension.activate(extensionContext);
  mockApi.kubeconfigPath = '/tmp/exists/kubeconfig';
  const fsReadFileSyncSpy = vi.spyOn(mockFsExtra, 'readFileSync');
  const fsWriteFileSyncSpy = vi.spyOn(mockFsExtra, 'writeFileSync');
  const registerConnectionSpy = vi.spyOn(mockApi.providerInstace,'registerKubernetesProviderConnection');

  await mockApi.providerInstanceFactory.create({
    'redhat.sandbox.login.command': '--server=https://api.sandbox.redhat.com:6443 --token=token',
    'redhat.sandbox.context.name': 'sandbox',
  });

  expect(registerConnectionSpy).toHaveBeenCalled();
  expect(fsReadFileSyncSpy).toHaveBeenCalled();
  // TODO: find out how to override Math.random() to know the name of the user and server
  expect(fsWriteFileSyncSpy).toHaveBeenCalled();
});
