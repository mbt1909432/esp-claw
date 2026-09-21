/*
 * SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include "http_server_priv.h"

#define HTTP_SERVER_WIFI_SCAN_LIMIT 20

static esp_err_t wifi_scan_handler(httpd_req_t *req)
{
    http_server_ctx_t *ctx = http_server_ctx();
    http_server_wifi_scan_record_t records[HTTP_SERVER_WIFI_SCAN_LIMIT] = {0};
    uint16_t count = 0;
    esp_err_t err;

    if (!ctx->services.scan_wifi) {
        return httpd_resp_send_err(req, HTTPD_501_NOT_IMPLEMENTED, "Wi-Fi scanning is unavailable");
    }

    err = ctx->services.scan_wifi(records, HTTP_SERVER_WIFI_SCAN_LIMIT, &count);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to scan nearby Wi-Fi");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_CreateArray();
    if (!root || !items) {
        cJSON_Delete(root);
        cJSON_Delete(items);
        httpd_resp_send_500(req);
        return ESP_ERR_NO_MEM;
    }

    for (uint16_t i = 0; i < count; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) {
            cJSON_Delete(root);
            cJSON_Delete(items);
            httpd_resp_send_500(req);
            return ESP_ERR_NO_MEM;
        }
        http_server_json_add_string(item, "ssid", records[i].ssid);
        cJSON_AddNumberToObject(item, "rssi", records[i].rssi);
        cJSON_AddNumberToObject(item, "channel", records[i].primary);
        http_server_json_add_string(item, "auth", records[i].auth);
        cJSON_AddItemToArray(items, item);
    }

    cJSON_AddItemToObject(root, "items", items);
    cJSON_AddNumberToObject(root, "count", count);
    return http_server_send_json_response(req, root);
}

esp_err_t http_server_register_wifi_routes(httpd_handle_t server)
{
    const httpd_uri_t handler = {
        .uri = "/api/wifi/scan",
        .method = HTTP_GET,
        .handler = wifi_scan_handler,
    };
    return httpd_register_uri_handler(server, &handler);
}
