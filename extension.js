// Copyright 2018 Bartosz Jaroszewski
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 2 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const Main = imports.ui.main;
const GnomeBluetooth = imports.gi.GnomeBluetooth;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const UiExtension = Me.imports.ui;

class BluetoothDevice {
    constructor(model, device) {
        this._name = model.get_value(device, GnomeBluetooth.Column.NAME);
        this._isConnected = model.get_value(device, GnomeBluetooth.Column.CONNECTED);
        this._isPaired = model.get_value(device, GnomeBluetooth.Column.PAIRED);
        this._mac = model.get_value(device, GnomeBluetooth.Column.ADDRESS);
    }

    get name() {
        return this._name;
    }

    get isConnected() {
        return this._isConnected;
    }

    get isPaired() {
        return this._isPaired;
    }

    get mac() {
        return this._mac;
    }

    get item() {
        if (!this._item)
            this._item = new UiExtension.PopupBluetoothDeviceMenuItem(this);

        return this._item;
    }

    disconnect() {
        this._call_cmd(`bluetoothctl -- disconnect ${this.mac}`)
    }

    connect() {
        this._call_cmd(`bluetoothctl -- connect ${this.mac}`)
    }

    reconnect() {
        this._call_cmd(`bluetoothctl -- disconnect ${this.mac} && bluetoothctl -- connect ${this.mac}`)
    }

    _call_cmd(command) {
        Util.spawn(['/usr/bin/env', 'bash', '-c', command]);
    }
}

class BluetoothQuickConnect {
    constructor(bluetooth, settings) {
        this._menu = bluetooth._item.menu;
        this._proxy = bluetooth._proxy;
        this._settings = settings;

        this._signals = [];
    }

    enable() {
        this._loadBluetoothModel();
        this._connectSignal(this._menu, 'open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._disconnectIdleMonitor()
            else
                this._connectIdleMonitor();

            if (isOpen && this._autoPowerOnEnabled())
                this._proxy.BluetoothAirplaneMode = false;

            this._sync();
        });

        this._connectSignal(this._model, 'row-changed', () => this._sync());
        this._connectSignal(this._model, 'row-deleted', () => this._sync());
        this._connectSignal(this._model, 'row-inserted', () => this._sync());

        this._connectIdleMonitor();
        if (!this._proxy.BluetoothAirplaneMode) {
            this._sync();
        }
    }

    disable() {
        this._destroy();
    }

    test() {
        try {
            GLib.spawn_command_line_sync("bluetoothctl --version");
        } catch (error) {
            Main.notifyError(_('Bluetooth quick connect'),  _(`Error trying to execute "bluetoothctl"`));
        }
    }

    _connectIdleMonitor() {
        if (this._idleMonitorId) return;

        this._idleMonitorId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._autoPowerOffCheckingInterval() * 1000, () => {
            if (this._autoPowerOffEnabled() && this._getConnectedDevices().length === 0)
                this._proxy.BluetoothAirplaneMode = true;

            return true;
        });
    }

    _disconnectIdleMonitor() {
        if (!this._idleMonitorId) return;

        GLib.Source.remove(this._idleMonitorId);
        this._idleMonitorId = null;
    }

    _connectSignal(subject, signal_name, method) {
        let signal_id = subject.connect(signal_name, method);
        this._signals.push({
            subject: subject,
            signal_id: signal_id
        });
    }

    _loadBluetoothModel() {
        this._client = new GnomeBluetooth.Client();
        this._model = this._client.get_model();
    }

    _getDefaultAdapter() {
        let [ret, iter] = this._model.get_iter_first();
        while (ret) {
            let isDefault = this._model.get_value(iter, GnomeBluetooth.Column.DEFAULT);
            let isPowered = this._model.get_value(iter, GnomeBluetooth.Column.POWERED);
            if (isDefault && isPowered)
                return iter;
            ret = this._model.iter_next(iter);
        }
        return null;
    }

    _getDevices() {
        let adapter = this._getDefaultAdapter();
        if (!adapter)
            return [];

        let devices = [];

        let [ret, iter] = this._model.iter_children(adapter);
        while (ret) {
            devices.push(new BluetoothDevice(this._model, iter));
            ret = this._model.iter_next(iter);
        }

        return devices;
    }

    _getPairedDevices() {
        return this._getDevices().filter((device) => {
            return device.isPaired || device.isConnected;
        });
    }

    _getConnectedDevices() {
        return this._getDevices().filter((device) => {
            return device.isConnected;
        });
    }

    _sync() {
        this._removeDevicesFromMenu();
        this._addDevicesToMenu();
    }

    _addDevicesToMenu() {
        this._getPairedDevices().forEach((device) => {
            device.item.isEmitActivatedEnabled = !this._keepMenuOnToggle();
            if (!this._showRefreshButton())
                device.item.hideRefreshButton();

            this._menu.addMenuItem(device.item, 1);
        });
    }

    _removeDevicesFromMenu() {
        this._menu._getMenuItems().forEach((item) => {
            if (item.isBluetoothDeviceSwitcher) {
                item.destroy();
            }
        });
    }

    _destroy() {
        this._signals.forEach((signal) => {
            signal.subject.disconnect(signal.signal_id);
        });
        this._signals = [];
        this._removeDevicesFromMenu();
        this._disconnectIdleMonitor();
    }

    _autoPowerOnEnabled() {
        return this._settings.get_boolean('bluetooth-auto-power-on');
    }

    _autoPowerOffEnabled() {
        return this._settings.get_boolean('bluetooth-auto-power-off');
    }

    _autoPowerOffCheckingInterval() {
        return this._settings.get_int('bluetooth-auto-power-off-interval');
    }

    _keepMenuOnToggle() {
        return this._settings.get_boolean('keep-menu-on-toggle');
    }

    _showRefreshButton() {
        return this._settings.get_boolean('refresh-button-on');
    }
}

let bluetoothQuickConnect = null;

function init() {
    let bluetooth = Main.panel.statusArea.aggregateMenu._bluetooth;
    let settings = Convenience.getSettings();
    bluetoothQuickConnect = new BluetoothQuickConnect(bluetooth, settings);
}

function enable() {
    bluetoothQuickConnect.test();
    bluetoothQuickConnect.enable();
}

function disable() {
    bluetoothQuickConnect.disable();
}
