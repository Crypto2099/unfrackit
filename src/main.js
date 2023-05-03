import Vue from "vue";
import App from "./App.vue";
import vuetify from "./plugins/vuetify";
import vueCardano from "@/plugins/vue-cardano";
import VueSweetalert2 from "vue-sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";

Vue.use(vueCardano);
Vue.use(VueSweetalert2);

Vue.config.productionTip = false;

new Vue({
  vuetify,
  render: (h) => h(App),
}).$mount("#app");
