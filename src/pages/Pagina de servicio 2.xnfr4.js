/*
=============================================================================
MODULE: pages/servicio-2.js
VERSION: v5011-SERVICE-CATALOG-CANONICAL
=============================================================================
*/

import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web";

import {
  MESSAGE_TYPES,
  URLS,
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";

let bridge = null;
let resolvedService = null;

function text(value, fallback = "") {
  return _safeTrim(value) || fallback;
}

function getSafeMessage(error, fallback) {
  return text(error?.message, fallback);
}

function showError(message) {
  const safeMessage = text(
    message,
    "No se pudo cargar el servicio."
  );

  console.error("[servicio-2] Error:", safeMessage);

  try {
    const banner = $w("#errorBanner");

    if (!banner) {
      return;
    }

    banner.text = `Error: ${safeMessage}`;

    if (typeof banner.show === "function") {
      banner.show();
    }
  } catch (error) {
    console.warn(
      "[servicio-2] No se pudo mostrar el error:",
      error?.message
    );
  }
}

function getMessageType(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  return text(
    message.type || message.action
  ).toUpperCase();
}

function getPayload(message) {
  if (
    !message ||
    typeof message !== "object" ||
    !message.payload ||
    typeof message.payload !== "object" ||
    Array.isArray(message.payload)
  ) {
    return {};
  }

  return message.payload;
}

function getReferenceId(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return text(value);
  }

  if (typeof value === "object") {
    return text(
      value.id ||
      value.serviceId ||
      value.nativeId ||
      value.value
    );
  }

  return "";
}

function getServiceId(service) {
  if (!service || typeof service !== "object") {
    return "";
  }

  return getReferenceId(service.serviceId);
}

function getServiceSlug(service) {
  if (!service || typeof service !== "object") {
    return "";
  }

  return _safeSlugOrId(service.slug || "");
}

function getServiceImage(service) {
  if (!service || typeof service !== "object") {
    return "";
  }

  return text(service.mainMedia);
}

function getLinkedPhaseId(value) {
  if (Array.isArray(value)) {
    return getReferenceId(value[0]);
  }

  return getReferenceId(value);
}

function getAddOnOptions(service) {
  if (!service || typeof service !== "object") {
    return [];
  }

  return Array.isArray(service.addOnOptions)
    ? service.addOnOptions
    : [];
}

function normalizeService(data) {
  if (!data || typeof data !== "object") {
    throw new Error("El servicio recibido no es válido.");
  }

  const serviceId = getServiceId(data);
  const slug = getServiceSlug(data);
  const mainMedia = getServiceImage(data);
  const addOnOptions = getAddOnOptions(data);
  const linkedPhases = getLinkedPhaseId(data.linkedPhases);

  if (!_looksLikeGuid(serviceId)) {
    throw new Error(
      "El servicio no tiene un serviceId válido."
    );
  }

  if (!slug) {
    throw new Error(
      "El servicio no tiene un slug válido."
    );
  }

  return {
    serviceId,
    slug,
    title: text(data.title),
    description: text(data.description),
    location: text(data.location),
    totalDuration: data.totalDuration ?? 0,
    price: data.price ?? 0,
    mainMedia,
    addOnOptions,
    linkedPhases,
    availableStaff: Array.isArray(data.availableStaff)
      ? data.availableStaff
      : [],
    clientHidden: Boolean(data.clientHidden),
    allowCombine: Boolean(data.allowCombine)
  };
}

async function resolveServiceLookup() {
  const query = wixLocation.query || {};

  const candidates = [
    query.slug,
    query.serviceId
  ];

  for (const candidate of candidates) {
    const value = _safeSlugOrId(candidate);

    if (value) {
      return value;
    }
  }

  const path = Array.isArray(wixLocation.path)
    ? wixLocation.path
    : [];

  const value = _safeSlugOrId(
    path[path.length - 1] || ""
  );

  const excludedPaths = new Set([
    "servicios",
    "service",
    "servicio",
    "servicio-2"
  ]);

  if (!value || excludedPaths.has(value)) {
    return null;
  }

  return value;
}

function getAddOnIds(payload) {
  if (
    !payload ||
    !Array.isArray(payload.addOnOptions)
  ) {
    return [];
  }

  return Array.from(
    new Set(
      payload.addOnOptions
        .map((addOn) => {
          if (!addOn || typeof addOn !== "object") {
            return "";
          }

          return text(addOn.addOnId);
        })
        .filter(Boolean)
    )
  ).slice(0, 21);
}

function buildBookingUrl(service, payload) {
  const base = text(
    URLS?.CALENDARIO_2,
    "/booking-calendar/calendario-2"
  );

  const serviceId = getServiceId(service);
  const slug = getServiceSlug(service);

  const query = [
    `slug=${encodeURIComponent(slug)}`,
    `serviceId=${encodeURIComponent(serviceId)}`,
    "referral=servicio-2"
  ];

  const addOnIds = getAddOnIds(payload);

  if (addOnIds.length > 0) {
    query.push(
      `addOnIds=${encodeURIComponent(addOnIds.join(","))}`
    );
  }

  return `${base}?${query.join("&")}`;
}

function getServicesUrl() {
  return text(
    URLS?.SERVICIOS,
    "/reserva-online"
  );
}

async function loadService(lookupValue) {
  const result = await getServiceBySlugOrId(lookupValue);

  if (
    !result ||
    result.status !== "SUCCESS" ||
    !result.data ||
    typeof result.data !== "object"
  ) {
    throw new Error(
      result?.error?.message ||
      "Servicio no encontrado."
    );
  }

  return normalizeService(result.data);
}

$w.onReady(async () => {
  const traceId = makeTraceId("servicio");

  let widget;

  try {
    widget = $w("#htmlWidgetCustomService");
  } catch (error) {
    showError(
      "El widget del servicio no está disponible."
    );
    return;
  }

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    showError(
      "El widget del servicio no está disponible."
    );
    return;
  }

  try {
    const lookupValue = await resolveServiceLookup();

    if (!lookupValue) {
      showError(
        "No se pudo localizar el servicio en la URL."
      );
      return;
    }

    bridge = createWidgetBridge(widget, {
      slug: lookupValue,
      traceId,

      onContextReady: async () => {
        resolvedService = await loadService(
          lookupValue
        );

        return resolvedService;
      },

      onWidgetMessage: async (message) => {
        const type = getMessageType(message);
        const payload = getPayload(message);

        if (!resolvedService) {
          console.warn(
            "[servicio-2] Servicio aún no disponible",
            {
              traceId,
              type
            }
          );
          return;
        }

        if (type === MESSAGE_TYPES.BOOK) {
          wixLocation.to(
            buildBookingUrl(
              resolvedService,
              payload
            )
          );
          return;
        }

        if (type === MESSAGE_TYPES.NAV) {
          const target = text(
            payload.target
          ).toUpperCase();

          if (
            !target ||
            target === "SERVICIOS"
          ) {
            wixLocation.to(
              getServicesUrl()
            );
          }

          return;
        }

        if (
          type === MESSAGE_TYPES.READY ||
          type === MESSAGE_TYPES.CONTEXT
        ) {
          return;
        }

        console.warn(
          "[servicio-2] Mensaje no soportado",
          {
            traceId,
            type
          }
        );
      },

      onError: (error) => {
        showError(
          getSafeMessage(
            error,
            "No se pudo cargar el servicio."
          )
        );
      }
    });

    if (!bridge) {
      showError(
        "No se pudo inicializar el widget del servicio."
      );
    }
  } catch (error) {
    console.error(
      "[servicio-2] Error de inicialización",
      {
        traceId,
        message: error?.message
      }
    );

    showError(
      getSafeMessage(
        error,
        "No se pudo cargar el servicio."
      )
    );
  }
});

Este código usa únicamente los nombres canónicos de la matriz: `serviceId`, `slug`, `linkedPhases`, `addOnOptions`, `addOnIds`, `mainMedia`, `availableStaff` y `clientHidden`.
