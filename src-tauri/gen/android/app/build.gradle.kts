import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing comes only from the environment (CI secrets or ~/.reader-release);
// the keystore and its passwords never enter the repository.
val releaseSigning = listOf(
    "READER_ANDROID_KEYSTORE",
    "READER_ANDROID_STORE_PASSWORD",
    "READER_ANDROID_KEY_ALIAS",
    "READER_ANDROID_KEY_PASSWORD",
).associateWith { System.getenv(it) }
val canSignRelease = releaseSigning.values.all { !it.isNullOrEmpty() }

android {
    compileSdk = 37
    namespace = "org.reader.books"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "org.reader.books"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = file(releaseSigning.getValue("READER_ANDROID_KEYSTORE")!!)
                storePassword = releaseSigning.getValue("READER_ANDROID_STORE_PASSWORD")
                keyAlias = releaseSigning.getValue("READER_ANDROID_KEY_ALIAS")
                keyPassword = releaseSigning.getValue("READER_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (canSignRelease) signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("com.google.android.gms:play-services-auth:22.0.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// Never produce an unsigned or debug-signed release by accident.
gradle.taskGraph.whenReady {
    if (!canSignRelease && allTasks.any { it.name.startsWith("package") && it.name.contains("Release") }) {
        throw GradleException("Release builds need READER_ANDROID_KEYSTORE, READER_ANDROID_STORE_PASSWORD, READER_ANDROID_KEY_ALIAS and READER_ANDROID_KEY_PASSWORD.")
    }
}
