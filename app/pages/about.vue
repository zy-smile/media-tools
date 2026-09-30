<template>
  <div>
    <video
      v-if="!errorMessage"
      src="http://192.168.1.115:9000/pano/dev/6aa8f8a08a9e10f54bef11c8.mp4"
      controls
      width="640"
      height="360"
      @error="errorMessageHandler"
    />
    <p v-else role="alert">视频加载失败：{{ errorMessage }}</p>
  </div>
</template>
<script setup>
import { ref } from 'vue'

const errorMessage = ref('')
const errorMessageHandler = () => {
  errorMessage.value = '无法加载演示视频，请确认媒体地址可访问（当前为内网地址）。'
}
</script>
