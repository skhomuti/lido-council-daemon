import { PrometheusModule as PrometheusModuleSource } from '@willsoto/nestjs-prometheus';
import {
  PrometheusPauseDepositsCounterProvider,
  PrometheusTransportMessageCounterProvider,
  PrometheusAccountBalanceProvider,
  PrometheusRPCErrorsCounterProvider,
  PrometheusRPCRequestsHistogramProvider,
  PrometheusBlockDataErrorsCounterProvider,
  PrometheusBlockDataRequestsProvider,
  PrometheusBuildInfoGaugeProvider,
} from './prometheus.provider';
import { METRICS_PREFIX, METRICS_URL } from './prometheus.constants';

export const PrometheusModule = PrometheusModuleSource.register({
  path: METRICS_URL,
  defaultMetrics: {
    enabled: true,
    config: { prefix: METRICS_PREFIX },
  },
});

const providers = [
  PrometheusTransportMessageCounterProvider,
  PrometheusPauseDepositsCounterProvider,
  PrometheusRPCRequestsHistogramProvider,
  PrometheusRPCErrorsCounterProvider,
  PrometheusAccountBalanceProvider,
  PrometheusBlockDataRequestsProvider,
  PrometheusBlockDataErrorsCounterProvider,
  PrometheusBuildInfoGaugeProvider,
];

PrometheusModule.global = true;
PrometheusModule.providers = providers;
PrometheusModule.exports = providers;
